module.exports = {
    testEnvironment: 'node',
    testMatch: ['**/test/**/*_spec.js'],
    testTimeout: 10000,
    verbose: true,
    testPathIgnorePatterns: [
        '/node_modules/',
        '/\\.venv/',
        '/notebooks_venv/',
        '/training/notebooks/.*/.pixi/',
        '/__pycache__/'
    ],
    modulePathIgnorePatterns: [
        '/\\.venv/',
        '/notebooks_venv/',
        '/training/notebooks/.*/.pixi/'
    ]
};

