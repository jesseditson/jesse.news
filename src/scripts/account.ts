import { el, RequestError, store, write } from "./social.js";

const SESSION_KEY = "jesse.news:session";
const CLAIM_KEY = "jesse.news:comment-token";

export interface User {
  id: number;
  name: string;
  role: string;
}

interface Signed {
  session?: string;
  user: User;
  liked: string[];
}

type Json = Record<string, unknown>;

const state: { user: User | null; liked: Set<string> } = { user: null, liked: new Set() };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

function signedIn({ session, user, liked }: Signed): User {
  if (session) store.set(SESSION_KEY, session);
  state.user = user;
  state.liked = new Set(liked);
  emit();
  return user;
}

function signedOut(): void {
  store.set(SESSION_KEY, null);
  state.user = null;
  state.liked = new Set();
  emit();
}

export const account = {
  get user(): User | null {
    return state.user;
  },
  likes: (path: string) => state.liked.has(path),
  setLiked(path: string, on: boolean): void {
    if (on) state.liked.add(path);
    else state.liked.delete(path);
  },
  onChange(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

// A request made as the signed-in account; a 401 means the session is gone, so this browser signs out.
export async function asUser<T>(action: string, body: Json = {}): Promise<T> {
  try {
    return await write<T>(action, { ...body, session: store.get(SESSION_KEY) });
  } catch (thrown) {
    if (thrown instanceof RequestError && thrown.status === 401) signedOut();
    throw thrown;
  }
}

const fromBase64 = (value: string): Uint8Array<ArrayBuffer> => {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base64 + "===".slice((base64.length + 3) % 4)), (char) => char.charCodeAt(0));
};

const toBase64 = (buffer: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const withIds = (list: unknown) =>
  Array.isArray(list) ? list.map((item: Json) => ({ ...item, id: fromBase64(String(item.id)) })) : undefined;

// The JSON a server sends and expects, converted to and from the binary WebAuthn takes.
function creationOptions(json: Json): PublicKeyCredentialCreationOptions {
  const user = json.user as Json;
  return {
    ...json,
    challenge: fromBase64(String(json.challenge)),
    user: { ...user, id: fromBase64(String(user.id)) },
    excludeCredentials: withIds(json.excludeCredentials),
  } as unknown as PublicKeyCredentialCreationOptions;
}

function requestOptions(json: Json): PublicKeyCredentialRequestOptions {
  return {
    ...json,
    challenge: fromBase64(String(json.challenge)),
    allowCredentials: withIds(json.allowCredentials),
  } as unknown as PublicKeyCredentialRequestOptions;
}

function credentialJSON(credential: PublicKeyCredential): Json {
  const response = credential.response as Partial<AuthenticatorAttestationResponse & AuthenticatorAssertionResponse>;
  const encoded = (buffer: ArrayBuffer | null | undefined) => (buffer ? toBase64(buffer) : undefined);
  return {
    id: credential.id,
    rawId: toBase64(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
    clientExtensionResults: credential.getClientExtensionResults(),
    response: response.attestationObject
      ? {
          clientDataJSON: encoded(response.clientDataJSON),
          attestationObject: encoded(response.attestationObject),
          transports: response.getTransports?.() ?? [],
        }
      : {
          clientDataJSON: encoded(response.clientDataJSON),
          authenticatorData: encoded(response.authenticatorData),
          signature: encoded(response.signature),
          userHandle: encoded(response.userHandle),
        },
  };
}

// The browser reports "no passkey here" and "the visitor dismissed it" alike, so either way the visitor may need one made.
class NoPasskey extends Error {}

function passkeyError(thrown: unknown, making: boolean): Error {
  if (thrown instanceof DOMException && thrown.name === "NotAllowedError") {
    return making ? new Error("No passkey was made.") : new NoPasskey("No passkey was used.");
  }
  if (thrown instanceof DOMException && thrown.name === "InvalidStateError") {
    return new Error("This device already has a passkey here. Sign in with it.");
  }
  return thrown instanceof Error ? thrown : new Error("That didn't work. Please try again.");
}

async function signInWithPasskey(): Promise<User> {
  const { ticket, options } = await write<{ ticket: string; options: Json }>("signin-options", {});
  let credential: Credential | null;
  try {
    credential = await navigator.credentials.get({ publicKey: requestOptions(options) });
  } catch (thrown) {
    throw passkeyError(thrown, false);
  }
  if (!(credential instanceof PublicKeyCredential)) throw new NoPasskey("No passkey was used.");
  try {
    signedIn(await write<Signed>("signin", { ticket, response: credentialJSON(credential) }));
  } catch (thrown) {
    // A passkey this site has no account for, left behind by a deleted account or another copy of the site.
    if (thrown instanceof RequestError && thrown.status === 404) throw new NoPasskey(thrown.message);
    throw thrown;
  }
  await claimIfPending();
  return state.user!;
}

// The site's author hands over the admin token once, as ?comment_token=, to claim the author role.
async function claimIfPending(): Promise<void> {
  const adminToken = store.get(CLAIM_KEY);
  if (!adminToken || !state.user || state.user.role === "author") return;
  try {
    const { user } = await asUser<{ user: User }>("claim", { adminToken });
    store.set(CLAIM_KEY, null);
    state.user = user;
    emit();
  } catch (thrown) {
    if (thrown instanceof RequestError && thrown.status === 403) store.set(CLAIM_KEY, null);
  }
}

async function createPasskey(name: string): Promise<User> {
  const adminToken = store.get(CLAIM_KEY);
  const { ticket, options } = await write<{ ticket: string; options: Json }>("register-options", {
    name,
    ...(adminToken ? { adminToken } : {}),
  });
  let credential: Credential | null;
  try {
    credential = await navigator.credentials.create({ publicKey: creationOptions(options) });
  } catch (thrown) {
    throw passkeyError(thrown, true);
  }
  if (!(credential instanceof PublicKeyCredential)) throw new Error("No passkey was made.");
  const signed = await write<Signed>("register", { ticket, response: credentialJSON(credential) });
  if (adminToken) store.set(CLAIM_KEY, null);
  return signedIn(signed);
}

export async function signOut(): Promise<void> {
  await asUser("signout").catch(() => undefined);
  signedOut();
}

type Step = "create" | "name";

let dialog: { open(step: Step, problem?: string): Promise<User> } | null = null;

// Shown only when signing in didn't find a passkey: making one is the one thing it asks for.
function buildDialog(): { open(step: Step, problem?: string): Promise<User> } {
  const node = el("dialog", "account-dialog");
  node.innerHTML = `
    <form method="dialog" class="account-dismiss">
      <button class="account-close" aria-label="Close">
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M7 7l10 10M17 7 7 17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      </button>
    </form>
    <form class="account-step" data-account-step="create" novalidate>
      <h2 class="account-title" id="account-create-title">Like and comment with a passkey</h2>
      <p class="account-explain" data-account-explain></p>
      <label class="account-label" for="account-new-name">Your name, as people will see it</label>
      <div class="account-row">
        <input id="account-new-name" name="name" type="text" maxlength="40" autocomplete="nickname" required>
        <button type="submit" class="account-save" data-account-create>Create passkey</button>
      </div>
      <button type="button" class="account-link" data-account-retry>Already have one? Sign in</button>
    </form>
    <form class="account-step" data-account-step="name" novalidate hidden>
      <h2 class="account-title" id="account-name-title">Your name</h2>
      <p class="account-explain">This is the name people see on your comments. Change it whenever you like.</p>
      <div class="account-row">
        <label class="visually-hidden" for="account-name">Your name</label>
        <input id="account-name" name="name" type="text" maxlength="40" autocomplete="nickname" required>
        <button type="submit" class="account-save">Save</button>
      </div>
      <button type="button" class="account-link" data-account-keep>Keep this name</button>
    </form>
    <p class="account-error" data-account-error role="alert"></p>`;
  node.querySelector("[data-account-explain]")!.textContent =
    `A passkey signs you in to ${window.location.hostname} with your device's Face ID, Touch ID, fingerprint or PIN. ` +
    "No password or email, and it follows you to your other devices.";
  document.body.append(node);

  const createStep = node.querySelector<HTMLFormElement>("[data-account-step=create]")!;
  const newName = createStep.querySelector<HTMLInputElement>("input[name=name]")!;
  const nameStep = node.querySelector<HTMLFormElement>("[data-account-step=name]")!;
  const createButton = createStep.querySelector<HTMLButtonElement>("[data-account-create]")!;
  const retryButton = createStep.querySelector<HTMLButtonElement>("[data-account-retry]")!;
  const nameField = nameStep.querySelector<HTMLInputElement>("input[name=name]")!;
  const saveButton = nameStep.querySelector<HTMLButtonElement>(".account-save")!;
  const error = node.querySelector<HTMLElement>("[data-account-error]")!;
  let waiting: { resolve: (user: User) => void; reject: (error: Error) => void } | null = null;

  const show = (step: Step) => {
    createStep.hidden = step !== "create";
    nameStep.hidden = step !== "name";
    node.setAttribute("aria-labelledby", step === "create" ? "account-create-title" : "account-name-title");
    if (step === "name") nameField.value = state.user?.name ?? "";
  };
  const settle = (user: User) => {
    const done = waiting;
    waiting = null;
    done?.resolve(user);
  };
  const attempt = async (button: HTMLButtonElement, work: () => Promise<void>) => {
    error.textContent = "";
    createButton.disabled = retryButton.disabled = button.disabled = true;
    try {
      await work();
    } catch (thrown) {
      error.textContent = thrown instanceof Error ? thrown.message : "That didn't work. Please try again.";
    } finally {
      createButton.disabled = retryButton.disabled = saveButton.disabled = false;
    }
  };

  createStep.addEventListener("submit", (event) => {
    event.preventDefault();
    const name = newName.value.trim();
    if (!name) {
      error.textContent = "Pick a name first.";
      newName.focus();
      return;
    }
    attempt(createButton, async () => {
      settle(await createPasskey(name));
      node.close();
    });
  });
  retryButton.addEventListener("click", () =>
    attempt(retryButton, async () => {
      settle(await signInWithPasskey());
      node.close();
    }),
  );
  nameStep.addEventListener("submit", (event) => {
    event.preventDefault();
    if (nameField.value.trim() === state.user?.name) {
      node.close();
      return;
    }
    attempt(saveButton, async () => {
      const { user } = await asUser<{ user: User }>("rename", { name: nameField.value });
      state.user = user;
      emit();
      node.close();
    });
  });
  nameStep.querySelector("[data-account-keep]")!.addEventListener("click", () => node.close());

  node.addEventListener("close", () => {
    const done = waiting;
    waiting = null;
    done?.reject(new Error("Not signed in."));
  });

  return {
    open(step, problem = "") {
      error.textContent = problem;
      show(step);
      if (!node.open) node.showModal();
      (step === "name" ? nameField : newName).select();
      return new Promise<User>((resolve, reject) => {
        waiting = { resolve, reject };
        if (step === "name" && state.user) settle(state.user);
      });
    },
  };
}

let signingIn: Promise<User> | null = null;

// Browsers show no text of a site's own in their passkey prompt, so the page says what it's for beside what was clicked.
function promptHint(purpose: string, near?: Element | null): HTMLElement | null {
  if (!near) return null;
  const hint = el("p", "account-hint", `Choose your passkey to ${purpose}. No passkey yet? Close the prompt and we'll make you one.`);
  hint.setAttribute("role", "status");
  near.after(hint);
  return hint;
}

// Resolves with the signed-in account. Signing in goes straight to the browser's passkey prompt, so a
// returning visitor never sees the dialog; only someone without a passkey is offered one.
export function requireAccount(purpose = "sign in", near?: Element | null): Promise<User> {
  if (state.user) return Promise.resolve(state.user);
  signingIn ??= (async () => {
    const hint = promptHint(purpose, near);
    try {
      return await signInWithPasskey();
    } catch (thrown) {
      hint?.remove();
      dialog ??= buildDialog();
      const problem = thrown instanceof NoPasskey ? "" : thrown instanceof Error ? thrown.message : "";
      return await dialog.open("create", problem);
    } finally {
      hint?.remove();
    }
  })().finally(() => {
    signingIn = null;
  });
  return signingIn;
}

function renderNote(): void {
  const note = document.querySelector<HTMLElement>("[data-account-note]");
  const name = note?.querySelector<HTMLElement>("[data-account-name]");
  if (!note || !name) return;
  note.hidden = !state.user;
  name.textContent = state.user?.name ?? "";
}

export async function initAccount(): Promise<void> {
  const url = new URL(window.location.href);
  const adminToken = url.searchParams.get("comment_token");
  if (adminToken) {
    store.set(CLAIM_KEY, adminToken);
    url.searchParams.delete("comment_token");
    history.replaceState(history.state, "", url.toString());
  }

  account.onChange(renderNote);
  document.querySelector("[data-account-signout]")?.addEventListener("click", () => signOut());
  document.querySelector("[data-account-rename]")?.addEventListener("click", () => {
    dialog ??= buildDialog();
    dialog.open("name").catch(() => undefined);
  });

  if (store.get(SESSION_KEY)) {
    try {
      signedIn(await asUser<Signed>("me"));
    } catch {
      // Signed out or unreachable: the page works signed out.
    }
  }
  await claimIfPending();
}
