module.exports = {
    flowFile: "flows.json",
    credentialSecret: "demo-credential-secret-not-for-prod",
    uiPort: process.env.PORT || 1880,
    uiHost: "0.0.0.0",
    diagnostics: { enabled: true, ui: true },
    runtimeState: { enabled: false, ui: false },
    logging: { console: { level: "info", metrics: false, audit: false } },
    exportGlobalContextKeys: false,
    externalModules: {},
    editorTheme: {
        projects: { enabled: false, workflow: { mode: "manual" } },
        codeEditor: { lib: "monaco", options: {} }
    },
    functionExternalModules: true,
    functionGlobalContext: {}
};
