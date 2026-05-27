import { loadSavedConnections, saveSavedConnections, SavedConnection } from "./ServerSettings";

describe("ServerSettings storage helpers", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns an empty list when no saved connections exist", () => {
    expect(loadSavedConnections()).toEqual([]);
  });

  it("saves and loads connection configs — password is stripped on save", () => {
    const connections: SavedConnection[] = [
      {
        name: "local",
        config: {
          host: "127.0.0.1",
          port: 19669,
          username: "root",
          password: "test-password",
        },
      },
    ];

    saveSavedConnections(connections);

    // Password is intentionally not persisted
    expect(loadSavedConnections()).toEqual([
      {
        name: "local",
        config: {
          host: "127.0.0.1",
          port: 19669,
          username: "root",
          password: "",
        },
      },
    ]);
  });
});
