// One writer at a time. Two schedulers (the repository workflow and the
// desktop ticker) can fire together; a second concurrent sweep would see a
// half-updated registry and duplicate work.
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { paths } from "./paths.mjs";

export function acquireLock(dir = paths().intel, staleMinutes = 20, now = Date.now()) {
  const file = paths(dir).lock;
  mkdirSync(dirname(file), { recursive: true });
  const take = () => {
    const fd = openSync(file, "wx");
    try {
      writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date(now).toISOString(), host: process.env.COMPUTERNAME || "" }));
    } finally {
      closeSync(fd);
    }
    return { acquired: true, stale: false, file };
  };
  try {
    return take();
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
  }
  // Held. Take over only when the holder is provably old, never on a guess.
  let ageMinutes = 0;
  let holder = null;
  try {
    ageMinutes = (now - statSync(file).mtimeMs) / 60_000;
    holder = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    ageMinutes = Number.POSITIVE_INFINITY; // unreadable lock: treat as stale
  }
  if (ageMinutes >= staleMinutes) {
    try {
      unlinkSync(file);
    } catch {
      /* someone else recovered it first */
    }
    return { ...take(), stale: true };
  }
  return { acquired: false, stale: false, file, holder, ageMinutes };
}

export function releaseLock(dir = paths().intel) {
  try {
    unlinkSync(paths(dir).lock);
  } catch {
    /* already gone */
  }
}
