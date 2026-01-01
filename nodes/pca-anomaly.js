module.exports = function(RED) {
    "use strict";
    
    function PcaAnomalyNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        
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
        
        // State
        this.dataBuffer = [];
        this.mean = null;
        this.eigenVectors = null;
        this.eigenValues = null;
        this.isTrained = false;
        this.t2Threshold = null;
        this.speThreshold = null;
        
        node.status({fill: "blue", shape: "ring", text: "PCA - waiting for data"});
        
        // Debug logging helper
        var debugLog = function(message) {
            if (node.debug) {
                node.warn("[DEBUG] " + message);
            }
        };
        
        // Helper: Calculate mean of each column
        function calculateColumnMeans(matrix) {
            var nCols = matrix[0].length;
            var means = new Array(nCols).fill(0);
            
            for (var i = 0; i < matrix.length; i++) {
                for (var j = 0; j < nCols; j++) {
                    means[j] += matrix[i][j];
                }
            }
            
            for (var j = 0; j < nCols; j++) {
                means[j] /= matrix.length;
            }
            
            return means;
        }
        
        // Helper: Calculate standard deviation of each column
        function calculateColumnStdDevs(matrix, means) {
            var nCols = matrix[0].length;
            var stdDevs = new Array(nCols).fill(0);
            
            for (var i = 0; i < matrix.length; i++) {
                for (var j = 0; j < nCols; j++) {
                    stdDevs[j] += Math.pow(matrix[i][j] - means[j], 2);
                }
            }
            
            for (var j = 0; j < nCols; j++) {
                stdDevs[j] = Math.sqrt(stdDevs[j] / matrix.length);
                if (stdDevs[j] === 0) stdDevs[j] = 1; // Avoid division by zero
            }
            
            return stdDevs;
        }
        
        // Helper: Center and scale matrix
        function standardize(matrix, means, stdDevs) {
            var result = [];
            for (var i = 0; i < matrix.length; i++) {
                var row = [];
                for (var j = 0; j < matrix[i].length; j++) {
                    row.push((matrix[i][j] - means[j]) / stdDevs[j]);
                }
                result.push(row);
            }
            return result;
        }
        
        // Helper: Matrix transpose
        function transpose(matrix) {
            var rows = matrix.length;
            var cols = matrix[0].length;
            var result = [];
            
            for (var j = 0; j < cols; j++) {
                var row = [];
                for (var i = 0; i < rows; i++) {
                    row.push(matrix[i][j]);
                }
                result.push(row);
            }
            
            return result;
        }
        
        // Helper: Matrix multiplication
        function matMul(A, B) {
            var rowsA = A.length;
            var colsA = A[0].length;
            var colsB = B[0].length;
            var result = [];
            
            for (var i = 0; i < rowsA; i++) {
                var row = [];
                for (var j = 0; j < colsB; j++) {
                    var sum = 0;
                    for (var k = 0; k < colsA; k++) {
                        sum += A[i][k] * B[k][j];
                    }
                    row.push(sum);
                }
                result.push(row);
            }
            
            return result;
        }
        
        // Helper: Covariance matrix
        function covarianceMatrix(matrix) {
            var n = matrix.length;
            var means = calculateColumnMeans(matrix);
            var nCols = matrix[0].length;
            var cov = [];
            
            for (var i = 0; i < nCols; i++) {
                var row = [];
                for (var j = 0; j < nCols; j++) {
                    var sum = 0;
                    for (var k = 0; k < n; k++) {
                        sum += (matrix[k][i] - means[i]) * (matrix[k][j] - means[j]);
                    }
                    row.push(sum / (n - 1));
                }
                cov.push(row);
            }
            
            return cov;
        }
        
        // Power iteration for eigenvalue/eigenvector calculation
        function powerIteration(matrix, numIterations) {
            var n = matrix.length;
            var eigenVectors = [];
            var eigenValues = [];
            var workMatrix = JSON.parse(JSON.stringify(matrix));
            
            for (var comp = 0; comp < n; comp++) {
                // Initialize random vector
                var v = [];
                for (var i = 0; i < n; i++) {
                    v.push(Math.random() - 0.5);
                }
                
                // Normalize
                var norm = Math.sqrt(v.reduce((sum, val) => sum + val * val, 0));
                v = v.map(val => val / norm);
                
                // Power iteration
                for (var iter = 0; iter < numIterations; iter++) {
                    // Multiply matrix by vector
                    var newV = [];
                    for (var i = 0; i < n; i++) {
                        var sum = 0;
                        for (var j = 0; j < n; j++) {
                            sum += workMatrix[i][j] * v[j];
                        }
                        newV.push(sum);
                    }
                    
                    // Calculate eigenvalue (Rayleigh quotient)
                    var eigenValue = 0;
                    for (var i = 0; i < n; i++) {
                        eigenValue += v[i] * newV[i];
                    }
                    
                    // Normalize
                    norm = Math.sqrt(newV.reduce((sum, val) => sum + val * val, 0));
                    if (norm > 0) {
                        v = newV.map(val => val / norm);
                    }
                }
                
                // Calculate final eigenvalue
                var Av = [];
                for (var i = 0; i < n; i++) {
                    var sum = 0;
                    for (var j = 0; j < n; j++) {
                        sum += workMatrix[i][j] * v[j];
                    }
                    Av.push(sum);
                }
                var eigenValue = 0;
                for (var i = 0; i < n; i++) {
                    eigenValue += v[i] * Av[i];
                }
                
                eigenVectors.push(v);
                eigenValues.push(eigenValue);
                
                // Deflate matrix
                for (var i = 0; i < n; i++) {
                    for (var j = 0; j < n; j++) {
                        workMatrix[i][j] -= eigenValue * v[i] * v[j];
                    }
                }
            }
            
            return { eigenValues: eigenValues, eigenVectors: eigenVectors };
        }
        
        // Train PCA model
        function trainPCA() {
            if (node.dataBuffer.length < node.windowSize * 0.5) {
                return false;
            }
            
            var data = node.dataBuffer.map(d => d.values);
            var nFeatures = data[0].length;
            
            // Calculate means and std devs for standardization
            node.mean = calculateColumnMeans(data);
            node.stdDev = calculateColumnStdDevs(data, node.mean);
            
            // Standardize data
            var standardizedData = standardize(data, node.mean, node.stdDev);
            
            // Calculate covariance matrix
            var cov = covarianceMatrix(standardizedData);
            
            // Calculate eigenvalues and eigenvectors
            var eigen = powerIteration(cov, 100);
            
            // Sort by eigenvalue (descending)
            var indices = eigen.eigenValues.map((val, idx) => ({val, idx}));
            indices.sort((a, b) => b.val - a.val);
            
            node.eigenValues = indices.map(i => eigen.eigenValues[i.idx]);
            node.eigenVectors = indices.map(i => eigen.eigenVectors[i.idx]);
            
            // Determine number of components
            if (node.autoComponents) {
                var totalVariance = node.eigenValues.reduce((a, b) => a + Math.max(0, b), 0);
                var cumulativeVariance = 0;
                node.nComponents = 0;
                
                for (var i = 0; i < node.eigenValues.length; i++) {
                    cumulativeVariance += Math.max(0, node.eigenValues[i]);
                    node.nComponents = i + 1;
                    if (cumulativeVariance / totalVariance >= node.varianceThreshold) {
                        break;
                    }
                }
            }
            
            node.nComponents = Math.min(node.nComponents, nFeatures);
            
            // Mark as trained so calculateStatistics works
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
            
            // Set thresholds at specified percentile (based on threshold config)
            if (t2Values.length > 0) {
                t2Values.sort((a, b) => a - b);
                speValues.sort((a, b) => a - b);
                
                var percentileIndex = Math.floor(t2Values.length * (1 - 1/node.threshold/10));
                node.t2Threshold = t2Values[percentileIndex] || t2Values[t2Values.length - 1];
                node.speThreshold = speValues[percentileIndex] || speValues[speValues.length - 1];
            } else {
                // Default thresholds if no valid statistics
                node.t2Threshold = node.threshold * node.threshold;
                node.speThreshold = node.threshold;
            }
            
            debugLog("PCA trained: " + node.nComponents + " components, T² threshold: " + node.t2Threshold.toFixed(4) + ", SPE threshold: " + node.speThreshold.toFixed(4));
            
            return true;
        }
        
        // Calculate T² and SPE statistics for a sample
        function calculateStatistics(standardizedSample) {
            if (!node.isTrained) return null;
            
            // Project onto principal components
            var scores = [];
            for (var i = 0; i < node.nComponents; i++) {
                var score = 0;
                for (var j = 0; j < standardizedSample.length; j++) {
                    score += standardizedSample[j] * node.eigenVectors[i][j];
                }
                scores.push(score);
            }
            
            // Calculate T² (Hotelling's T-squared)
            var t2 = 0;
            for (var i = 0; i < node.nComponents; i++) {
                if (node.eigenValues[i] > 0) {
                    t2 += (scores[i] * scores[i]) / node.eigenValues[i];
                }
            }
            
            // Reconstruct sample from principal components
            var reconstructed = new Array(standardizedSample.length).fill(0);
            for (var i = 0; i < node.nComponents; i++) {
                for (var j = 0; j < standardizedSample.length; j++) {
                    reconstructed[j] += scores[i] * node.eigenVectors[i][j];
                }
            }
            
            // Calculate SPE (Squared Prediction Error)
            var spe = 0;
            for (var j = 0; j < standardizedSample.length; j++) {
                spe += Math.pow(standardizedSample[j] - reconstructed[j], 2);
            }
            
            return {
                scores: scores,
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
                    node.mean = null;
                    node.eigenVectors = null;
                    node.eigenValues = null;
                    node.status({fill: "blue", shape: "ring", text: "PCA - reset"});
                    return;
                }
                
                // Extract multi-dimensional input
                var values = [];
                var valueNames = [];
                
                if (Array.isArray(msg.payload)) {
                    values = msg.payload.filter(v => typeof v === 'number' && !isNaN(v));
                    valueNames = values.map((v, i) => "sensor" + i);
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
                var standardizedSample = [];
                for (var i = 0; i < values.length; i++) {
                    standardizedSample.push((values[i] - node.mean[i]) / node.stdDev[i]);
                }
                
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
                
                // Always calculate contributions for analysis
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
                contributions.sort((a, b) => b.contribution - a.contribution);
                
                // Filter by threshold and limit to top N
                var filteredContributions = contributions
                    .filter(function(c) { return c.normalizedContribution >= node.contributionThreshold; })
                    .slice(0, node.showTopContributors);
                
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
                        explainedVariance: node.eigenValues.slice(0, node.nComponents).reduce((a, b) => a + b, 0) / 
                                          node.eigenValues.reduce((a, b) => a + Math.max(0, b), 0)
                    },
                    contributions: filteredContributions.length > 0 ? filteredContributions : undefined,
                    allContributions: isAnomaly ? contributions : undefined, // Full list only for anomalies
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
        
        node.on('close', function() {
            node.dataBuffer = [];
            node.isTrained = false;
            node.mean = null;
            node.eigenVectors = null;
            node.eigenValues = null;
            node.status({});
        });
    }
    
    RED.nodes.registerType("pca-anomaly", PcaAnomalyNode);
};
