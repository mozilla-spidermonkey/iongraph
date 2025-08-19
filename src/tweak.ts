export interface TweaksOptions {
  container: HTMLElement,
}

export class Tweaks {
  container: HTMLElement;
  tweaks: Tweak[];

  constructor(options: TweaksOptions) {
    this.container = options.container;
    this.tweaks = [];
  }

  add(tweak: Tweak) {
    this.tweaks.push(tweak);

    const el = document.createElement("div");
    this.container.appendChild(el);
    el.style.display = "flex";
    el.style.alignItems = "center";
    el.style.justifyContent = "end";
    el.style.gap = "0.5rem";

    const safename = tweak.name.replace(/[a-zA-Z0-9]/g, "_");

    const label = document.createElement("label");
    el.appendChild(label);
    label.innerText = tweak.name;
    label.htmlFor = `tweak-${safename}-input`;

    const input = document.createElement("input");
    el.appendChild(input);
    input.type = "number";
    input.value = String(tweak);
    input.id = `tweak-${safename}-input`;
    input.style.width = "4rem";
    input.addEventListener("input", () => {
      tweak.set(input.valueAsNumber);
    });

    const range = document.createElement("input");
    el.appendChild(range);
    range.type = "range";
    range.value = String(tweak);
    range.min = String(tweak.min);
    range.max = String(tweak.max);
    range.addEventListener("input", () => {
      tweak.set(range.valueAsNumber);
    });

    const reset = document.createElement("button");
    el.appendChild(reset);
    reset.innerText = "Reset";
    reset.disabled = tweak.get() === tweak.initial;
    reset.addEventListener("click", () => {
      tweak.set(tweak.initial);
    });

    tweak.onChange(v => {
      input.value = String(v);
      range.value = String(v);
      reset.disabled = tweak.get() === tweak.initial;
      window.dispatchEvent(new CustomEvent("tweak", { detail: tweak }));
    });

    this.container.style.visibility = "visible";
  }
}

// We do some awful TypeScript nonsense to pretend that the Tweak interface is
// a number. It does support valueOf and whatnot, so it coerces to number in
// normal use. It should not however be assigned to a number, and the Tweak
// type should disallow this. (Also, using const should just prevent you from
// doing that in general.)
export type Tweak = number & _Tweak;
interface _Tweak {
  get(): number;
  set(v: number): void;
  valueOf(): number;
  toString(): string;
  [Symbol.toPrimitive](hint: "number" | "string" | "default"): number | string;
  onChange(func: TweakCallback): void;
  initial: number;
  name: string;
  min: number;
  max: number;
}

export interface TweakOptions {
  min?: number,
  max?: number,

  tweaksObject?: Tweaks,
}

export type TweakCallback = (newValue: number) => void;

export function tweak(name: string, initial: number, options: TweakOptions = {}): Tweak {
  let value = initial;
  let callbacks: TweakCallback[] = [];

  let min: number;
  let max: number;

  if (options.min !== undefined && options.max !== undefined) {
    min = options.min;
    max = options.max;
  } else if (options.min !== undefined) {
    min = options.min;
    max = options.min + 100;
  } else if (options.max !== undefined) {
    min = options.max - 100;
    max = options.max;
  } else {
    min = 0;
    max = 100;
  }

  const t: _Tweak = {
    get(): number {
      return value;
    },

    set(v: number) {
      value = v;
      for (const func of callbacks) {
        func(value);
      }
    },

    valueOf(): number {
      return value;
    },

    toString(): string {
      return String(value);
    },

    [Symbol.toPrimitive](hint: "number" | "string" | "default"): number | string {
      if (hint === "string") {
        return String(value);
      }
      return value;
    },

    onChange(func: TweakCallback) {
      callbacks.push(func);
    },

    initial: initial,
    name: name,
    min: min,
    max: max,
  };

  (options.tweaksObject ?? globalTweaks).add(t as Tweak);

  return t as Tweak;
}

const globalContainer = document.createElement("div");
globalContainer.style.visibility = "hidden";
globalContainer.style.position = "absolute";
globalContainer.style.bottom = "0";
globalContainer.style.right = "0";
globalContainer.style.padding = "1rem";
globalContainer.style.border = "1px solid black";
globalContainer.style.borderWidth = "1px 0 0 1px";
globalContainer.style.backgroundColor = "white";
document.querySelector("body")?.appendChild(globalContainer);

export const globalTweaks = new Tweaks({ container: globalContainer });

// export function tweak(val: number) {
//   globalTweaks.add(val);
// }

/* @ts-ignore */
window.tweaks = globalTweaks;

// // Type system tests, uncomment to check
// const testContainer = document.createElement("div");
// const testTweaks = new Tweaks({ container: testContainer });
// let testTweak = tweak(3, { tweaksObject: testTweaks });
// /* ERROR */ testTweak = 4;
// /*    OK */ testTweak.set(4);
