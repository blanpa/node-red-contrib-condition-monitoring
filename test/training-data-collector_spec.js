const helper = require("node-red-node-test-helper");
const trainingDataCollectorNode = require("../nodes/training-data-collector.js");
const fs = require("fs");
const path = require("path");
const os = require("os");

helper.init(require.resolve("node-red"));

describe("training-data-collector Node", function() {
    
    // Temp directory for test data
    let testDataDir;
    
    beforeEach(function(done) {
        testDataDir = path.join(os.tmpdir(), "node-red-test-" + Date.now());
        fs.mkdirSync(testDataDir, { recursive: true });
        helper.startServer(done);
    });
    
    afterEach(function(done) {
        helper.unload();
        helper.stopServer(function() {
            // Cleanup test directory
            try {
                if (fs.existsSync(testDataDir)) {
                    fs.rmSync(testDataDir, { recursive: true, force: true });
                }
            } catch (err) {
                // Ignore cleanup errors
            }
            done();
        });
    });
    
    // Helper to create node with settings
    function createFlow(nodeConfig) {
        return [
            { 
                id: "n1", 
                type: "training-data-collector",
                name: "test-collector",
                datasetName: "test_dataset",
                outputPath: "",
                mode: "batch",
                autoSave: false,
                featureSource: "payload",
                featureFields: "",
                includeTimestamp: true,
                timestampFormat: "iso",
                labelMode: "manual",
                labelField: "label",
                defaultLabel: "normal",
                bufferSize: 100,
                windowSize: 10,
                windowOverlap: 50,
                flushOnDeploy: false,
                exportFormat: "csv",
                compressionEnabled: false,
                compressionThreshold: 10000,
                shuffleOnExport: false,
                includeMetadata: true,
                s3Enabled: false,
                validateData: true,
                wires: [["n2"]],
                ...nodeConfig
            },
            { id: "n2", type: "helper" }
        ];
    }
    
    it("should be loaded", function(done) {
        var flow = createFlow({});
        helper.load(trainingDataCollectorNode, flow, { userDir: testDataDir }, function() {
            var n1 = helper.getNode("n1");
            try {
                expect(n1).toBeDefined();
                expect(n1.name).toBe("test-collector");
                expect(n1.datasetName).toBe("test_dataset");
                expect(n1.mode).toBe("batch");
                done();
            } catch (err) {
                done(err);
            }
        });
    });
    
    it("should collect numeric payload", function(done) {
        var flow = createFlow({});
        helper.load(trainingDataCollectorNode, flow, { userDir: testDataDir }, function() {
            var n1 = helper.getNode("n1");
            
            // Send numeric data
            n1.receive({ payload: 42.5 });
            n1.receive({ payload: 43.2 });
            n1.receive({ payload: 41.8 });
            
            // Check buffer
            setTimeout(function() {
                try {
                    expect(n1.dataBuffer).toBeDefined();
                    expect(n1.dataBuffer.length).toBe(3);
                    expect(n1.dataBuffer[0].features.value).toBe(42.5);
                    done();
                } catch (err) {
                    done(err);
                }
            }, 100);
        });
    });
    
    it("should collect object payload with features", function(done) {
        var flow = createFlow({});
        helper.load(trainingDataCollectorNode, flow, { userDir: testDataDir }, function() {
            var n1 = helper.getNode("n1");
            
            // Send object data
            n1.receive({ 
                payload: { 
                    temperature: 65.5, 
                    vibration_rms: 0.742, 
                    pressure: 2.1 
                }
            });
            
            setTimeout(function() {
                try {
                    n1.dataBuffer.length.should.equal(1);
                    n1.dataBuffer[0].features.should.have.property("temperature", 65.5);
                    n1.dataBuffer[0].features.should.have.property("vibration_rms", 0.742);
                    n1.dataBuffer[0].features.should.have.property("pressure", 2.1);
                    n1.featureNames.should.containDeep(["temperature", "vibration_rms", "pressure"]);
                    done();
                } catch (err) {
                    done(err);
                }
            }, 100);
        });
    });
    
    it("should collect array payload", function(done) {
        var flow = createFlow({});
        helper.load(trainingDataCollectorNode, flow, { userDir: testDataDir }, function() {
            var n1 = helper.getNode("n1");
            
            n1.receive({ payload: [0.5, 0.6, 0.7, 0.8] });
            
            setTimeout(function() {
                try {
                    n1.dataBuffer.length.should.equal(1);
                    n1.dataBuffer[0].values.should.deepEqual([0.5, 0.6, 0.7, 0.8]);
                    done();
                } catch (err) {
                    done(err);
                }
            }, 100);
        });
    });
    
    it("should use default label", function(done) {
        var flow = createFlow({ defaultLabel: "healthy" });
        helper.load(trainingDataCollectorNode, flow, { userDir: testDataDir }, function() {
            var n1 = helper.getNode("n1");
            
            n1.receive({ payload: 42 });
            
            setTimeout(function() {
                try {
                    n1.dataBuffer[0].label.should.equal("healthy");
                    done();
                } catch (err) {
                    done(err);
                }
            }, 100);
        });
    });
    
    it("should extract label from message", function(done) {
        var flow = createFlow({ labelMode: "fromMessage", labelField: "label" });
        helper.load(trainingDataCollectorNode, flow, { userDir: testDataDir }, function() {
            var n1 = helper.getNode("n1");
            
            n1.receive({ payload: 42, label: "bearing_fault" });
            
            setTimeout(function() {
                try {
                    n1.dataBuffer[0].label.should.equal("bearing_fault");
                    n1.labelClasses.has("bearing_fault").should.be.true();
                    done();
                } catch (err) {
                    done(err);
                }
            }, 100);
        });
    });
    
    it("should extract severity from message", function(done) {
        var flow = createFlow({});
        helper.load(trainingDataCollectorNode, flow, { userDir: testDataDir }, function() {
            var n1 = helper.getNode("n1");
            
            n1.receive({ payload: 42, label: "fault", severity: 0.7 });
            
            setTimeout(function() {
                try {
                    n1.dataBuffer[0].severity.should.equal(0.7);
                    done();
                } catch (err) {
                    done(err);
                }
            }, 100);
        });
    });
    
    it("should track label classes", function(done) {
        var flow = createFlow({ labelMode: "fromMessage" });
        helper.load(trainingDataCollectorNode, flow, { userDir: testDataDir }, function() {
            var n1 = helper.getNode("n1");
            
            n1.receive({ payload: 1, label: "normal" });
            n1.receive({ payload: 2, label: "bearing" });
            n1.receive({ payload: 3, label: "unbalance" });
            n1.receive({ payload: 4, label: "normal" });
            
            setTimeout(function() {
                try {
                    n1.labelClasses.size.should.equal(3);
                    n1.labelClasses.has("normal").should.be.true();
                    n1.labelClasses.has("bearing").should.be.true();
                    n1.labelClasses.has("unbalance").should.be.true();
                    done();
                } catch (err) {
                    done(err);
                }
            }, 100);
        });
    });
    
    it("should calculate statistics", function(done) {
        var flow = createFlow({});
        helper.load(trainingDataCollectorNode, flow, { userDir: testDataDir }, function() {
            var n1 = helper.getNode("n1");
            
            n1.receive({ payload: { value: 10 } });
            n1.receive({ payload: { value: 20 } });
            n1.receive({ payload: { value: 30 } });
            
            setTimeout(function() {
                try {
                    n1.statistics.should.have.property("value");
                    n1.statistics.value.count.should.equal(3);
                    n1.statistics.value.min.should.equal(10);
                    n1.statistics.value.max.should.equal(30);
                    n1.statistics.value.sum.should.equal(60);
                    done();
                } catch (err) {
                    done(err);
                }
            }, 100);
        });
    });
    
    it("should respond to stats action", function(done) {
        var flow = createFlow({});
        helper.load(trainingDataCollectorNode, flow, { userDir: testDataDir }, function() {
            var n1 = helper.getNode("n1");
            var n2 = helper.getNode("n2");
            
            // Add some data first
            n1.receive({ payload: { temp: 65 }, label: "normal" });
            n1.receive({ payload: { temp: 70 }, label: "fault" });
            
            n2.on("input", function(msg) {
                try {
                    msg.should.have.property("topic", "stats");
                    msg.payload.should.have.property("samples", 2);
                    msg.payload.should.have.property("features");
                    msg.payload.should.have.property("labelDistribution");
                    msg.payload.labelDistribution.should.have.property("normal", 1);
                    msg.payload.labelDistribution.should.have.property("fault", 1);
                    done();
                } catch (err) {
                    done(err);
                }
            });
            
            setTimeout(function() {
                n1.receive({ action: "stats" });
            }, 100);
        });
    });
    
    it("should respond to clear action", function(done) {
        var flow = createFlow({});
        helper.load(trainingDataCollectorNode, flow, { userDir: testDataDir }, function() {
            var n1 = helper.getNode("n1");
            var n2 = helper.getNode("n2");
            
            n1.receive({ payload: 42 });
            n1.receive({ payload: 43 });
            
            n2.on("input", function(msg) {
                try {
                    msg.payload.should.have.property("success", true);
                    msg.payload.should.have.property("action", "clear");
                    n1.dataBuffer.length.should.equal(0);
                    done();
                } catch (err) {
                    done(err);
                }
            });
            
            setTimeout(function() {
                n1.receive({ action: "clear" });
            }, 100);
        });
    });
    
    it("should respond to pause/resume actions", function(done) {
        var flow = createFlow({});
        helper.load(trainingDataCollectorNode, flow, { userDir: testDataDir }, function() {
            var n1 = helper.getNode("n1");
            
            n1.receive({ payload: 1 });
            n1.receive({ action: "pause" });
            n1.receive({ payload: 2 });  // Should be ignored
            n1.receive({ payload: 3 });  // Should be ignored
            n1.receive({ action: "resume" });
            n1.receive({ payload: 4 });
            
            setTimeout(function() {
                try {
                    n1.dataBuffer.length.should.equal(2);  // Only 1 and 4
                    done();
                } catch (err) {
                    done(err);
                }
            }, 200);
        });
    });
    
    it("should export to CSV", function(done) {
        var flow = createFlow({ exportFormat: "csv" });
        helper.load(trainingDataCollectorNode, flow, { userDir: testDataDir }, function() {
            var n1 = helper.getNode("n1");
            var n2 = helper.getNode("n2");
            
            n1.receive({ payload: { temp: 65, vib: 0.5 }, label: "normal" });
            n1.receive({ payload: { temp: 70, vib: 0.8 }, label: "fault" });
            
            n2.on("input", function(msg) {
                try {
                    msg.should.have.property("topic", "export");
                    msg.payload.should.have.property("success", true);
                    msg.payload.should.have.property("samples", 2);
                    msg.payload.should.have.property("files");
                    msg.payload.files.length.should.be.greaterThan(0);
                    
                    // Check CSV file exists
                    var csvFile = msg.payload.files.find(f => f.endsWith(".csv"));
                    csvFile.should.be.ok();
                    fs.existsSync(csvFile).should.be.true();
                    
                    done();
                } catch (err) {
                    done(err);
                }
            });
            
            setTimeout(function() {
                n1.receive({ action: "export" });
            }, 100);
        });
    });
    
    it("should export to JSONL", function(done) {
        var flow = createFlow({ exportFormat: "jsonl" });
        helper.load(trainingDataCollectorNode, flow, { userDir: testDataDir }, function() {
            var n1 = helper.getNode("n1");
            var n2 = helper.getNode("n2");
            
            n1.receive({ payload: [0.5, 0.6], label: "normal" });
            n1.receive({ payload: [0.7, 0.8], label: "fault" });
            
            n2.on("input", function(msg) {
                try {
                    msg.payload.should.have.property("success", true);
                    var jsonlFile = msg.payload.files.find(f => f.endsWith(".jsonl"));
                    jsonlFile.should.be.ok();
                    fs.existsSync(jsonlFile).should.be.true();
                    
                    // Verify JSONL content - may have 1 or 2 lines depending on clear
                    var content = fs.readFileSync(jsonlFile, "utf8");
                    var lines = content.trim().split("\n");
                    lines.length.should.be.greaterThanOrEqual(1);
                    
                    var line1 = JSON.parse(lines[0]);
                    line1.should.have.property("features");
                    
                    done();
                } catch (err) {
                    done(err);
                }
            });
            
            setTimeout(function() {
                n1.receive({ action: "export" });
            }, 100);
        });
    });
    
    it("should export to JSON with metadata", function(done) {
        var flow = createFlow({ exportFormat: "json", includeMetadata: true });
        helper.load(trainingDataCollectorNode, flow, { userDir: testDataDir }, function() {
            var n1 = helper.getNode("n1");
            var n2 = helper.getNode("n2");
            
            n1.receive({ payload: { temp: 65 }, label: "normal" });
            
            n2.on("input", function(msg) {
                try {
                    msg.payload.should.have.property("success", true);
                    
                    var jsonFile = msg.payload.files.find(f => f.endsWith(".json") && !f.includes("metadata"));
                    jsonFile.should.be.ok();
                    
                    var content = JSON.parse(fs.readFileSync(jsonFile, "utf8"));
                    content.should.have.property("datasetInfo");
                    content.should.have.property("data");
                    content.datasetInfo.should.have.property("features");
                    content.datasetInfo.should.have.property("statistics");
                    
                    // Check metadata file
                    var metaFile = msg.payload.files.find(f => f.includes("metadata"));
                    metaFile.should.be.ok();
                    
                    done();
                } catch (err) {
                    done(err);
                }
            });
            
            setTimeout(function() {
                n1.receive({ action: "export" });
            }, 100);
        });
    });
    
    it("should validate data and reject NaN", function(done) {
        var flow = createFlow({ validateData: true });
        helper.load(trainingDataCollectorNode, flow, { userDir: testDataDir }, function() {
            var n1 = helper.getNode("n1");
            
            n1.receive({ payload: 42 });
            n1.receive({ payload: NaN });  // Should be rejected
            n1.receive({ payload: 43 });
            
            setTimeout(function() {
                try {
                    n1.dataBuffer.length.should.equal(2);  // Only valid values
                    done();
                } catch (err) {
                    done(err);
                }
            }, 100);
        });
    });
    
    it("should use custom feature fields", function(done) {
        var flow = createFlow({ 
            featureSource: "custom", 
            featureFields: "sensor.temp,sensor.pressure" 
        });
        helper.load(trainingDataCollectorNode, flow, { userDir: testDataDir }, function() {
            var n1 = helper.getNode("n1");
            
            n1.receive({ 
                payload: { other: 999 },
                sensor: { temp: 65, pressure: 2.1, humidity: 40 }
            });
            
            setTimeout(function() {
                try {
                    n1.dataBuffer.length.should.equal(1);
                    n1.dataBuffer[0].features.should.have.property("sensor.temp", 65);
                    n1.dataBuffer[0].features.should.have.property("sensor.pressure", 2.1);
                    // humidity should not be included
                    n1.featureNames.should.not.containEql("sensor.humidity");
                    done();
                } catch (err) {
                    done(err);
                }
            }, 100);
        });
    });
    
    it("should handle RUL countdown mode", function(done) {
        var flow = createFlow({ 
            labelMode: "rul", 
            rulStartValue: 10, 
            rulUnit: "samples" 
        });
        helper.load(trainingDataCollectorNode, flow, { userDir: testDataDir }, function() {
            var n1 = helper.getNode("n1");
            
            n1.receive({ payload: 1 });
            n1.receive({ payload: 2 });
            n1.receive({ payload: 3 });
            
            setTimeout(function() {
                try {
                    n1.dataBuffer.length.should.equal(3);
                    // RUL decrements after recording, so first is start-1
                    n1.dataBuffer[0].label.should.equal(9);
                    n1.dataBuffer[1].label.should.equal(8);
                    n1.dataBuffer[2].label.should.equal(7);
                    done();
                } catch (err) {
                    done(err);
                }
            }, 100);
        });
    });
    
    it("should reset RUL on action", function(done) {
        var flow = createFlow({ 
            labelMode: "rul", 
            rulStartValue: 100, 
            rulUnit: "samples" 
        });
        helper.load(trainingDataCollectorNode, flow, { userDir: testDataDir }, function() {
            var n1 = helper.getNode("n1");
            var n2 = helper.getNode("n2");
            
            n1.receive({ payload: 1 });
            n1.receive({ payload: 2 });
            
            n2.on("input", function(msg) {
                if (msg.topic === "control" && msg.payload.action === "resetRul") {
                    try {
                        msg.payload.rul.should.equal(50);
                        n1.currentRul.should.equal(50);
                        done();
                    } catch (err) {
                        done(err);
                    }
                }
            });
            
            setTimeout(function() {
                n1.receive({ action: "resetRul", rulValue: 50 });
            }, 100);
        });
    });
    
    it("should handle timeseries mode with windows", function(done) {
        var flow = createFlow({ 
            mode: "timeseries", 
            windowSize: 5, 
            windowOverlap: 0 
        });
        helper.load(trainingDataCollectorNode, flow, { userDir: testDataDir }, function() {
            var n1 = helper.getNode("n1");
            
            // Send 10 samples (should create windows)
            for (var i = 0; i < 10; i++) {
                n1.receive({ payload: [i, i * 2], label: i < 5 ? "normal" : "fault" });
            }
            
            setTimeout(function() {
                try {
                    // Should have created at least 1 window
                    n1.dataBuffer.length.should.be.greaterThanOrEqual(1);
                    n1.dataBuffer[0].features.length.should.equal(5);  // Window of 5
                    done();
                } catch (err) {
                    done(err);
                }
            }, 200);
        });
    });
    
    it("should split data into train/val/test", function(done) {
        var flow = createFlow({ 
            exportFormat: "csv",
            shuffleOnExport: false  // Disable shuffle for predictable test
        });
        
        // Set split ratio via node property
        flow[0].splitRatio = { train: 0.6, val: 0.2, test: 0.2 };
        
        helper.load(trainingDataCollectorNode, flow, { userDir: testDataDir }, function() {
            var n1 = helper.getNode("n1");
            var n2 = helper.getNode("n2");
            
            // Add 10 samples
            for (var i = 0; i < 10; i++) {
                n1.receive({ payload: { value: i }, label: "class" + (i % 2) });
            }
            
            n2.on("input", function(msg) {
                try {
                    msg.payload.should.have.property("success", true);
                    msg.payload.should.have.property("splits");
                    msg.payload.splits.train.should.equal(6);
                    msg.payload.splits.val.should.equal(2);
                    msg.payload.splits.test.should.equal(2);
                    
                    // Should have 3 CSV files + metadata
                    msg.payload.files.length.should.be.greaterThanOrEqual(3);
                    
                    done();
                } catch (err) {
                    done(err);
                }
            });
            
            setTimeout(function() {
                n1.receive({ action: "export" });
            }, 100);
        });
    });
    
    it("should report label distribution", function(done) {
        var flow = createFlow({ labelMode: "fromMessage" });
        helper.load(trainingDataCollectorNode, flow, { userDir: testDataDir }, function() {
            var n1 = helper.getNode("n1");
            var n2 = helper.getNode("n2");
            
            // Unbalanced data
            for (var i = 0; i < 10; i++) n1.receive({ payload: i, label: "normal" });
            for (var i = 0; i < 2; i++) n1.receive({ payload: i, label: "fault" });
            
            n2.on("input", function(msg) {
                if (msg.topic === "export") {
                    try {
                        msg.payload.labelDistribution.should.have.property("normal", 10);
                        msg.payload.labelDistribution.should.have.property("fault", 2);
                        done();
                    } catch (err) {
                        done(err);
                    }
                }
            });
            
            setTimeout(function() {
                n1.receive({ action: "export" });
            }, 100);
        });
    });
    
    it("should handle empty export gracefully", function(done) {
        var flow = createFlow({});
        helper.load(trainingDataCollectorNode, flow, { userDir: testDataDir }, function() {
            var n1 = helper.getNode("n1");
            var n2 = helper.getNode("n2");
            
            n2.on("input", function(msg) {
                try {
                    msg.payload.should.have.property("success", false);
                    msg.payload.should.have.property("error");
                    msg.payload.samples.should.equal(0);
                    done();
                } catch (err) {
                    done(err);
                }
            });
            
            n1.receive({ action: "export" });
        });
    });
    
    it("should handle isAnomaly from anomaly-detector", function(done) {
        var flow = createFlow({ labelMode: "fromMessage" });
        helper.load(trainingDataCollectorNode, flow, { userDir: testDataDir }, function() {
            var n1 = helper.getNode("n1");
            
            // Simulate output from anomaly-detector
            n1.receive({ payload: 42, isAnomaly: false });
            n1.receive({ payload: 99, isAnomaly: true });
            
            setTimeout(function() {
                try {
                    n1.dataBuffer.length.should.equal(2);
                    n1.dataBuffer[0].label.should.equal("normal");  // Default when no anomaly
                    n1.dataBuffer[1].label.should.equal("anomaly");
                    done();
                } catch (err) {
                    done(err);
                }
            }, 100);
        });
    });
});
