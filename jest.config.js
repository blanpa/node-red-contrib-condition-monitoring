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
    // Coverage gate: keeps regressions out of merges/publishes. Measured the way
    // CI measures it — `--omit=optional`, no tfjs/onnx — at ≈64.8/55.8/70.4/66.0
    // as of v0.3.3.
    //
    // The margin below that is deliberately wide. Repeat runs are usually stable
    // to within ~0.1, but one run came in ~4.5 points lower across the board
    // (functions 70.4 -> 65.9) and did not reproduce; the cause was not pinned
    // down. Until it is, the gate sits below that outlier rather than just below
    // the typical reading, so a rare low sample cannot redden a green branch.
    //
    // Ratchet up as coverage grows, never down.
    collectCoverageFrom: ["nodes/**/*.js", "!nodes/python/**"],
    coverageThreshold: {
        global: {
            statements: 60,
            branches: 51,
            functions: 64,
            lines: 61
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
