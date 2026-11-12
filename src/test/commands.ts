import type { Command, EditCommand, Project } from "../studio/types";

/**
 * What the app's edit queue does with a command made by a function, for component
 * tests: the parameters are made from the project and sent on its revision; a
 * function that returns null sends nothing.
 */
export const sent = (command: Command, project: () => Project): EditCommand =>
  (method, params) => {
    if (typeof params !== "function") return command(method, params);
    const built = params(project());
    return built
      ? command(method, { ...built, expectedRevision: project().revision })
      : Promise.resolve(undefined);
  };
