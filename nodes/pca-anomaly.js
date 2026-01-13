module.exports = function(RED) {
    "use strict";
    
    // Import ml-pca and ml-matrix for robust PCA implementation
    var PCA = null;
    var Matrix = null;
    try {
        PCA = require('ml-pca').PCA;
        Matrix = require('ml-matrix').Matrix;
    } catch (err) {
        // Libraries not available - will show error on node creation
    }
    
    // Import state persistence
    var StatePersistence = null;
    try {
        StatePersistence = require('./state-persistence');
    } catch (err) {
        // State persistence not available
    }
    
    function PcaAnomalyNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        
        // Check if required libraries are available
        if (!PCA || !Matrix) {
            node.error("Required libraries not found. Please install: npm install ml-pca ml-matrix");
            node.status({fill: "red", shape: "ring", text: "Missing ml-pca/ml-matrix"});
            return;
        }
        
        // Configuration
        this.nComponents = parseInt(config.nComponents) || 2;
        this.windowSize = parseInt(config.windowSize) || 100;
        this.threshold = parseFloat(config.threshold) || 3.0;
        this.method = config.method || "t2"; // t2 (Hotelling's T²), spe (Squared Prediction Error), combined
        this.autoComponents = config.autoComponents !== false; // Auto-select components by explained variance
        this.varianceThreshold = parseFloat(config.varianceThreshold) || 0.95; // 95% variance explained
        this.contributionThreshold = parseFloat(config.contributionThreshold) || 0.1; // Min contribution to show
        this.showTopContributors = parseInt(config.showTopContributors) || 3; // Max contributors to show
        this.outputTopic = config.outputTopic || "";
        this.debug = config.debug === true;
        this.persistState = config.persistState === true;
        
        // State
        this.dataBuffer = [];
        this.pcaModel = null;       // ml-pca model instance
        this.mean = null;           // For standardization
        this.stdDev = null;         // For standardization
        this.isTrained = false;
        this.t2Threshold = null;
        this.speThreshold = null;
        
        // State persistence manager
        this.stateManager = null;
        
        // Debug logging helper
        var debugLog = function(message) {
            if (node.debug) {
                node.warn("[DEBUG] " + message);
            }
        };
        
        // Helper to persist current state
        // Note: ml-pca model can be serialized via toJSON()
        function persistCurrentState() {
            if (node.stateManager && node.isTrained && node.pcaModel) {
                node.stateManager.setMultiple({
                    dataBuffer: node.dataBuffer,
                    mean: node.mean,
                    stdDev: node.stdDev,
                    pcaModelJSON: node.pcaModel.toJSON(),
                    isTrained: node.isTrained,
                    t2Threshold: node.t2Threshold,
                    speThreshold: node.speThreshold,
                    nComponents: node.nComponents
                });
            }
        }
        
        // Initialize state persistence if enabled
        if (node.persistState && StatePersistence) {
            node.stateManager = new StatePersistence.NodeStateManager(node, {
                stateKey: 'pcaAnomalyState',
                saveInterval: 60000 // Save every 60 seconds
            });
            
            // Load persisted state on startup
            node.stateManager.load().then(function(state) {
                if (state.isTrained && state.pcaModelJSON) {
                    try {
                        node.dataBuffer = state.dataBuffer || [];
                        node.mean = state.mean;
                        node.stdDev = state.stdDev;
                        node.pcaModel = PCA.load(state.pcaModelJSON);
                        node.isTrained = true;
                        node.t2Threshold = state.t2Threshold;
                        node.speThreshold = state.speThreshold;
                        node.nComponents = state.nComponents || node.nComponents;
                        
                        node.status({fill: "green", shape: "dot", text: "PCA - restored (trained)"});
                        debugLog("Restored trained PCA model from persistence");
                    } catch (err) {
                        debugLog("Failed to restore PCA model: " + err.message);
                    }
                }
            }).catch(function(err) {
                debugLog("Failed to load persisted state: " + err.message);
            });
        }
        
        node.status({fill: "blue", shape: "ring", text: "PCA - waiting for data"});
        
        // Helper: Calculate mean of each column
        function calculateColumnMeans(data) {
            var nCols = data[0].length;
            var means = new Array(nCols).fill(0);
            
            for (var i = 0; i < data.length; i++) {
                for (var j = 0; j < nCols; j++) {
                    means[j] += data[i][j];
                }
            }
            
            for (var j = 0; j < nCols; j++) {
                means[j] /= data.length;
            }
            
            return means;
        }
        
        // Helper: Calculate standard deviation of each column
        function calculateColumnStdDevs(data, means) {
            var nCols = data[0].length;
            var stdDevs = new Array(nCols).fill(0);
            
            for (var i = 0; i < data.length; i++) {
                for (var j = 0; j < nCols; j++) {
                    stdDevs[j] += Math.pow(data[i][j] - means[j], 2);
                }
            }
            
            for (var j = 0; j < nCols; j++) {
                stdDevs[j] = Math.sqrt(stdDevs[j] / data.length);
                if (stdDevs[j] === 0) stdDevs[j] = 1; // Avoid division by zero
            }
            
            return stdDevs;
        }
        
        // Helper: Standardize data (z-score normalization)
        function standardize(data, means, stdDevs) {
            return data.map(function(row) {
                return row.map(function(val, j) {
                    return (val - means[j]) / stdDevs[j];
                });
            });
        }
        
        // Helper: Standardize single sample
        function standardizeSample(sample, means, stdDevs) {
            return sample.map(function(val, j) {
                return (val - means[j]) / stdDevs[j];
            });
        }
        
        // Train PCA model using ml-pca (SVD-based, numerically stable)
        function trainPCA() {
            if (node.dataBuffer.length < node.windowSize * 0.5) {
                return false;
            }
            
            var data = node.dataBuffer.map(function(d) { return d.values; });
            var nFeatures = data[0].length;
            
            // Calculate means and std devs for standardization
            node.mean = calculateColumnMeans(data);
            node.stdDev = calculateColumnStdDevs(data, node.mean);
            
            // Standardize data
            var standardizedData = standardize(data, node.mean, node.stdDev);
            
            // Train PCA using ml-pca (uses SVD internally - much more stable than power iteration)
            try {
                node.pcaModel = new PCA(standardizedData, {
                    center: false,  // Already centered via standardization
                    scale: false    // Already scaled via standardization
                });
            } catch (err) {
                node.error("PCA training failed: " + err.message);
                return false;
            }
            
            // Get explained variance ratios
            var explainedVariance = node.pcaModel.getExplainedVariance();
            var cumulativeVariance = node.pcaModel.getCumulativeVariance();
            
            debugLog("Explained variance per component: " + explainedVariance.map(function(v) { return (v * 100).toFixed(1) + "%"; }).join(", "));
            
            // Determine number of components based on variance threshold
            if (node.autoComponents) {
                node.nComponents = 1;
                for (var i = 0; i < cumulativeVariance.length; i++) {
                    if (cumulativeVariance[i] >= node.varianceThreshold) {
                        node.nComponents = i + 1;
                        break;
                    }
                    node.nComponents = i + 1;
                }
            }
            
            node.nComponents = Math.min(node.nComponents, nFeatures);
            
            // Mark as trained
            node.isTrained = true;
            
            // Calculate T² and SPE thresholds from training data
            var t2Values = [];
            var speValues = [];
            
            standardizedData.forEach(function(sample) {
                var stats = calculateStatistics(sample);
                if (stats) {
                    t2Values.push(stats.t2);
                    speValues.push(stats.spe);
                }
            });
            
            // Set thresholds at specified percentile
            if (t2Values.length > 0) {
                t2Values.sort(function(a, b) { return a - b; });
                speValues.sort(function(a, b) { return a - b; });
                
                var percentileIndex = Math.floor(t2Values.length * (1 - 1 / node.threshold / 10));
                percentileIndex = Math.min(percentileIndex, t2Values.length - 1);
                
                node.t2Threshold = t2Values[percentileIndex];
                node.speThreshold = speValues[percentileIndex];
            } else {
                node.t2Threshold = node.threshold * node.threshold;
                node.speThreshold = node.threshold;
            }
            
            var totalExplained = (cumulativeVariance[node.nComponents - 1] * 100).toFixed(1);
            debugLog("PCA trained: " + node.nComponents + " components (" + totalExplained + "% variance), T² threshold: " + node.t2Threshold.toFixed(4) + ", SPE threshold: " + node.speThreshold.toFixed(4));
            
            // Persist trained model
            persistCurrentState();
            
            return true;
        }
        
        // Calculate T² and SPE statistics for a sample
        function calculateStatistics(standardizedSample) {
            if (!node.isTrained || !node.pcaModel) return null;
            
            // Project onto principal components using ml-pca
            var allScores = node.pcaModel.predict([standardizedSample]).to2DArray()[0];
            var scores = allScores.slice(0, node.nComponents);
            
            // Get eigenvalues from ml-pca
            var eigenvalues = node.pcaModel.getEigenvalues();
            
            // Calculate T² (Hotelling's T-squared)
            var t2 = 0;
            for (var i = 0; i < node.nComponents; i++) {
                if (eigenvalues[i] > 1e-10) {
                    t2 += (scores[i] * scores[i]) / eigenvalues[i];
                }
            }
            
            // Get loading matrix for reconstruction
            var loadings = node.pcaModel.getLoadings().to2DArray();
            
            // Reconstruct sample from principal components
            var reconstructed = new Array(standardizedSample.length).fill(0);
            for (var i = 0; i < node.nComponents; i++) {
                for (var j = 0; j < standardizedSample.length; j++) {
                    reconstructed[j] += scores[i] * loadings[j][i];
                }
            }
            
            // Calculate SPE (Squared Prediction Error)
            var spe = 0;
            for (var j = 0; j < standardizedSample.length; j++) {
                spe += Math.pow(standardizedSample[j] - reconstructed[j], 2);
            }
            
            return {
                scores: scores,
                allScores: allScores,
                t2: t2,
                spe: spe,
                reconstructed: reconstructed
            };
        }
        
        node.on('input', function(msg) {
            try {
                // Reset command
                if (msg.reset === true) {
                    node.dataBuffer = [];
                    node.isTrained = false;
                    node.pcaModel = null;
                    node.mean = null;
                    node.stdDev = null;
                    node.status({fill: "blue", shape: "ring", text: "PCA - reset"});
                    return;
                }
                
                // Extract multi-dimensional input
                var values = [];
                var valueNames = [];
                
                if (Array.isArray(msg.payload)) {
                    values = msg.payload.filter(function(v) { return typeof v === 'number' && !isNaN(v); });
                    valueNames = values.map(function(v, i) { return "sensor" + i; });
                } else if (typeof msg.payload === 'object' && msg.payload !== null) {
                    Object.keys(msg.payload).forEach(function(key) {
                        var val = msg.payload[key];
                        if (typeof val === 'number' && !isNaN(val)) {
                            valueNames.push(key);
                            values.push(val);
                        } else if (typeof val === 'string' && !isNaN(parseFloat(val))) {
                            valueNames.push(key);
                            values.push(parseFloat(val));
                        }
                    });
                } else {
                    node.error("Payload must be an array or object with multiple sensor values", msg);
                    return;
                }
                
                if (values.length < 2) {
                    node.error("At least 2 sensor values are required for PCA", msg);
                    return;
                }
                
                // Add to buffer
                node.dataBuffer.push({
                    timestamp: Date.now(),
                    values: values,
                    names: valueNames
                });
                
                // Limit buffer size
                if (node.dataBuffer.length > node.windowSize) {
                    node.dataBuffer.shift();
                }
                
                // Train model when enough data
                if (!node.isTrained) {
                    if (node.dataBuffer.length >= Math.max(10, node.windowSize * 0.5)) {
                        trainPCA();
                    } else {
                        node.status({fill: "yellow", shape: "ring", text: "Training: " + node.dataBuffer.length + "/" + Math.floor(node.windowSize * 0.5)});
                        node.send([msg, null]);
                        return;
                    }
                }
                
                // Standardize current sample
                var standardizedSample = standardizeSample(values, node.mean, node.stdDev);
                
                // Calculate statistics
                var stats = calculateStatistics(standardizedSample);
                
                if (!stats) {
                    node.send([msg, null]);
                    return;
                }
                
                // Determine anomaly
                var isT2Anomaly = stats.t2 > node.t2Threshold;
                var isSPEAnomaly = stats.spe > node.speThreshold;
                var isAnomaly = false;
                
                switch (node.method) {
                    case "t2":
                        isAnomaly = isT2Anomaly;
                        break;
                    case "spe":
                        isAnomaly = isSPEAnomaly;
                        break;
                    case "combined":
                    default:
                        isAnomaly = isT2Anomaly || isSPEAnomaly;
                }
                
                // Calculate contribution to anomaly for each sensor
                var contributions = [];
                var totalContribution = 0;
                
                for (var i = 0; i < values.length; i++) {
                    var contrib = Math.abs(standardizedSample[i] - stats.reconstructed[i]);
                    totalContribution += contrib;
                    contributions.push({
                        sensor: valueNames[i],
                        contribution: contrib,
                        originalValue: values[i],
                        reconstructedValue: stats.reconstructed[i] * node.stdDev[i] + node.mean[i]
                    });
                }
                
                // Normalize and sort contributions
                contributions = contributions.map(function(c) {
                    c.normalizedContribution = totalContribution > 0 ? c.contribution / totalContribution : 0;
                    c.percentContribution = (c.normalizedContribution * 100).toFixed(1) + "%";
                    return c;
                });
                contributions.sort(function(a, b) { return b.contribution - a.contribution; });
                
                // Filter by threshold and limit to top N
                var filteredContributions = contributions
                    .filter(function(c) { return c.normalizedContribution >= node.contributionThreshold; })
                    .slice(0, node.showTopContributors);
                
                // Get explained variance info from ml-pca
                var cumulativeVariance = node.pcaModel.getCumulativeVariance();
                var explainedVarianceRatio = cumulativeVariance[node.nComponents - 1];
                
                // Build output message
                var outputMsg = {
                    payload: msg.payload,
                    isAnomaly: isAnomaly,
                    method: "pca-" + node.method,
                    pca: {
                        scores: stats.scores,
                        t2: stats.t2,
                        t2Threshold: node.t2Threshold,
                        t2Anomaly: isT2Anomaly,
                        spe: stats.spe,
                        speThreshold: node.speThreshold,
                        speAnomaly: isSPEAnomaly,
                        nComponents: node.nComponents,
                        explainedVariance: explainedVarianceRatio,
                        eigenvalues: node.pcaModel.getEigenvalues().slice(0, node.nComponents)
                    },
                    contributions: filteredContributions.length > 0 ? filteredContributions : undefined,
                    allContributions: isAnomaly ? contributions : undefined,
                    topContributor: contributions.length > 0 ? contributions[0].sensor : null,
                    sensorNames: valueNames,
                    bufferSize: node.dataBuffer.length,
                    timestamp: Date.now()
                };
                
                if (node.outputTopic) {
                    outputMsg.topic = node.outputTopic;
                }
                
                // Preserve original message properties
                Object.keys(msg).forEach(function(key) {
                    if (key !== 'payload' && !outputMsg.hasOwnProperty(key)) {
                        outputMsg[key] = msg[key];
                    }
                });
                
                // Update status
                var statusColor = isAnomaly ? "red" : "green";
                var statusText = "T²=" + stats.t2.toFixed(2) + " SPE=" + stats.spe.toFixed(2);
                if (isAnomaly && contributions.length > 0) {
                    statusText = "ANOMALY: " + contributions[0].sensor;
                }
                node.status({fill: statusColor, shape: isAnomaly ? "ring" : "dot", text: statusText});
                
                // Send to appropriate output
                if (isAnomaly) {
                    node.send([null, outputMsg]);
                } else {
                    node.send([outputMsg, null]);
                }
                
            } catch (err) {
                node.status({fill: "red", shape: "ring", text: "error"});
                node.error("Error in PCA analysis: " + err.message, msg);
            }
        });
        
        node.on('close', async function(done) {
            // Save state before closing if persistence enabled
            if (node.stateManager) {
                try {
                    persistCurrentState();
                    await node.stateManager.close();
                } catch (err) {
                    // Ignore persistence errors during shutdown
                }
            }
            
            node.dataBuffer = [];
            node.isTrained = false;
            node.pcaModel = null;
            node.mean = null;
            node.stdDev = null;
            node.status({});
            
            if (done) done();
        });
    }
    
    RED.nodes.registerType("pca-anomaly", PcaAnomalyNode);
};
