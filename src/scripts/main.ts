import { startBackdrop } from "./backdrop.js";
import { initFeed } from "./feed.js";
import { initZoom } from "./zoom.js";
import { initMedia } from "./media.js";
import { initBreeze } from "./breeze.js";
import { initWeather } from "./weather.js";
import { initMode } from "./mode.js";
import { initContact } from "./contact.js";
import { initAccount } from "./account.js";
import { initComments } from "./comments.js";
import { initNewsletter } from "./newsletter.js";
import { initFollow } from "./follow.js";
import { initDock } from "./dock.js";

const root = document.documentElement;
root.classList.add("js");

const prefersReducedMotion = window.matchMedia(
  "(prefers-reduced-motion: reduce)"
).matches;

const main = document.getElementById("main");

initMode();
// Before the zoom: a deep link opens its card immediately, and the thread mounts on that event.
if (main?.dataset.comments === "on") {
  initAccount();
  initComments();
}
initZoom({ prefersReducedMotion });
initMedia({ prefersReducedMotion });
initFeed();
initContact();
initNewsletter();
initFollow();
initDock();
startBackdrop({ prefersReducedMotion });

if (main?.dataset.breeze !== "off") {
  initBreeze({ prefersReducedMotion });
}

if (main?.dataset.rain !== "off") {
  initWeather({ prefersReducedMotion });
}
