import type { Clock } from "./ports.js";

export const systemClock: Clock = { now: () => new Date() };
