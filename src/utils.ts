export function clamp(x: number, min: number, max: number) {
  return Math.max(min, Math.min(max, x));
}

export type Falsy = null | undefined | false | 0 | -0 | 0n | "";

export function assert<T>(cond: T | Falsy, msg?: string, soft = false): asserts cond is T {
  if (!cond) {
    if (soft) {
      console.error(msg ?? "Assertion failed");
    } else {
      throw new Error(msg ?? "Assertion failed");
    }
  }
}

export function must<T>(val: T | Falsy, msg?: string): T {
  assert(val, msg);
  return val;
}
