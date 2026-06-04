import "@testing-library/jest-dom/vitest";

const createStorage = (): Storage => {
  let values: Record<string, string> = {};

  return {
    get length() {
      return Object.keys(values).length;
    },
    clear: () => {
      values = {};
    },
    getItem: (key: string) => values[key] ?? null,
    key: (index: number) => Object.keys(values)[index] ?? null,
    removeItem: (key: string) => {
      delete values[key];
    },
    setItem: (key: string, value: string) => {
      values[key] = String(value);
    },
  };
};

Object.defineProperty(window, "localStorage", {
  configurable: true,
  value: createStorage(),
});
