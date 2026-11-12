/** JSON.parse that answers undefined for text that isn't JSON. */
export const safeParse = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};
