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
    // Coverage gate: keeps regressions out of merges/publishes. Thresholds
    // sit a few points under the measured baseline (≈62/53/63/63 as of
    // v0.3.0) — ratchet them up as coverage grows, never down.
    collectCoverageFrom: ["nodes/**/*.js", "!nodes/python/**"],
    coverageThreshold: {
        global: {
            statements: 55,
            branches: 45,
            functions: 55,
            lines: 55
        }
    },
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
