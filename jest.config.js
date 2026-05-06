module.exports = {
    testEnvironment: "node",
    testMatch: ["**/test/**/*_spec.js"],
    testTimeout: 15000,
    verbose: true,
    testPathIgnorePatterns: [
        "/node_modules/",
        "/\\.venv/",
        "/notebooks_venv/",
        "/training/notebooks/.*/.pixi/",
        "/__pycache__/"
    ],
    modulePathIgnorePatterns: ["/\\.venv/", "/notebooks_venv/", "/training/notebooks/.*/.pixi/"],
    // Two test pools:
    //   - "integration": real Node-RED instances. They listen on sockets and
    //     hold their own per-suite resources. Run them serially to avoid port
    //     contention and CPU oversubscription.
    //   - "unit": everything else, parallelised normally.
    projects: [
        {
            displayName: "unit",
            testEnvironment: "node",
            testMatch: ["<rootDir>/test/**/*_spec.js"],
            testPathIgnorePatterns: ["/node_modules/", "<rootDir>/test/integration/"]
        },
        {
            displayName: "integration",
            testEnvironment: "node",
            testMatch: ["<rootDir>/test/integration/**/*_spec.js"],
            // Real Node-RED servers — run them one at a time to keep
            // EADDRINUSE retries and CPU pressure under control.
            maxWorkers: 1
        }
    ]
};
