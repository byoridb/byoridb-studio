import {
  loadSavedConnections,
  saveSavedConnections,
  upsertConnection,
  SavedConnection,
} from "./ServerSettings";

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

  it("upsertConnection adds a new connection with a default name", () => {
    const list = upsertConnection({
      host: "10.0.0.1",
      port: 19669,
      username: "root",
      password: "x",
    });
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("10.0.0.1:19669");
    // Password is never persisted to localStorage.
    expect(loadSavedConnections()[0].config.password).toBe("");
  });

  it("upsertConnection updates an existing connection in place by host:port:user", () => {
    upsertConnection({ host: "10.0.0.1", port: 19669, username: "root", password: "x" }, "prod");
    // Same identity, different password → update, keep the existing name.
    const list = upsertConnection({
      host: "10.0.0.1",
      port: 19669,
      username: "root",
      password: "y",
    });
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("prod");
  });

  it("upsertConnection treats a different username as a separate connection", () => {
    upsertConnection({ host: "10.0.0.1", port: 19669, username: "root", password: "x" });
    const list = upsertConnection({
      host: "10.0.0.1",
      port: 19669,
      username: "admin",
      password: "x",
    });
    expect(list).toHaveLength(2);
  });
});
