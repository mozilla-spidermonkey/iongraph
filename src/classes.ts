// Inspired by the common `classnames` utility.
// TODO: Is this used anymore?

export type ClassDescriptor = string | {
  [conditionalClass: string]: any,
};

export function classes(...descs: ClassDescriptor[]) {
  const pieces: string[] = [];
  for (const desc of descs) {
    if (typeof desc === "string") {
      pieces.push(desc);
    } else {
      for (const [name, doInclude] of Object.entries(desc)) {
        if (doInclude) {
          pieces.push(name);
        }
      }
    }
  }
  return pieces.join(" ");
}
