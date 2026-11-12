import { renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { coverControls, useCoveredInert } from "./coveredInert";

const rect = (left: number, width: number, top = 0, height = 20) =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
const place = (element: HTMLElement, box: DOMRect) => {
  element.getBoundingClientRect = () => box;
  return element;
};
const control = (parent: HTMLElement, tag: string, left: number, width = 40) => {
  const element = place(document.createElement(tag), rect(left, width));
  parent.append(element);
  return element;
};
const inert = (...elements: HTMLElement[]) => elements.map((element) => element.hasAttribute("inert"));
afterEach(() => document.body.replaceChildren());

it("makes inert exactly the controls under the cover and gives them back", () => {
  const surface = document.createElement("div"), drawer = place(document.createElement("aside"), rect(700, 326, 0, 600));
  document.body.append(surface, drawer);
  const play = control(surface, "button", 300);
  const volume = control(surface, "input", 720);
  const zoom = control(surface, "select", 800);
  // Half under the drawer's edge, centre still visible: it stays usable.
  const edge = control(surface, "button", 670, 50);
  // Not a control at all.
  const label = control(surface, "span", 900);
  const { update, release } = coverControls(surface, drawer);
  update();
  expect(inert(play, edge, label)).toEqual([false, false, false]);
  expect(inert(volume, zoom)).toEqual([true, true]);
  // The timeline scrolled: one clip came out from under the drawer, another went in.
  place(zoom, rect(500, 40));
  place(play, rect(900, 40));
  update();
  expect(inert(play, volume, zoom)).toEqual([true, true, false]);
  release();
  expect(inert(play, volume, zoom)).toEqual([false, false, false]);
});

it("leaves alone what is already inert and what has no box", () => {
  const surface = document.createElement("div"), drawer = place(document.createElement("aside"), rect(700, 326, 0, 600));
  const inspector = document.createElement("section");
  inspector.setAttribute("inert", "");
  surface.append(inspector);
  document.body.append(surface, drawer);
  const field = control(inspector, "input", 800);
  const hidden = control(surface, "button", 800, 0);
  const { update, release } = coverControls(surface, drawer);
  update();
  expect(inert(field, hidden)).toEqual([false, false]);
  release();
  // The inspector's own inert state is not this function's to lift.
  expect(inspector.hasAttribute("inert")).toBe(true);
});

it("covers the new surface when it was replaced while the drawer stayed open", () => {
  const drawer = place(document.createElement("aside"), rect(700, 326, 0, 600));
  const first = document.createElement("div"), second = document.createElement("div");
  document.body.append(first, drawer);
  const before = control(first, "button", 800);
  const surface = { current: first as HTMLElement | null };
  // As App calls it: the key changes with the home screen, `active` does not.
  const view = renderHook(({ mounted }) => useCoveredInert(surface, () => drawer, true, mounted), {
    initialProps: { mounted: "true:false" },
  });
  expect(inert(before)).toEqual([true]);
  // Home: the surface is unmounted.
  first.remove();
  surface.current = null;
  view.rerender({ mounted: "true:true" });
  expect(inert(before)).toEqual([false]);
  // Back in the editor: another element, the drawer still over it.
  document.body.append(second);
  const after = control(second, "button", 800), free = control(second, "button", 300);
  surface.current = second;
  view.rerender({ mounted: "true:false" });
  expect(inert(after, free)).toEqual([true, false]);
  view.unmount();
  expect(inert(after)).toEqual([false]);
});
