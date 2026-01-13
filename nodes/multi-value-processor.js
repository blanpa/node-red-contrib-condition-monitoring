module.exports = function(RED) {
    "use strict";
    
    // Import ml-matrix for robust matrix operations (Mahalanobis distance)
    var Matrix = null;
    try {
        Matrix = require('ml-matrix').Matrix;
    } catch (err) {
        // ml-matrix not available - will use fallback implementation
    }
    
    function MultiValueProcessorNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        
        // Configuration
        this.mode = config.mode || "split"; // split, analyze, correlate, aggregate
        this.field = config.field || "payload";
        
        // Aggregation settings
        this.aggregateMethod = config.aggregateMethod || "mean"; // mean, median, min, max, sum, range, stddev
        this.aggregateOutput = config.aggregateOutput || "single"; // single, all
        this.outputMode = config.outputMode || "sequential"; // sequential, parallel
        this.preserveOriginal = config.preserveOriginal !== false;
        
        // Anomaly detection settings
        this.anomalyMethod = config.anomalyMethod || "zscore"; // zscore, iqr, threshold, mahalanobis
        this.threshold = parseFloat(config.threshold) || 3.0;
        this.warningThreshold = parseFloat(config.warningThreshold) || 2.0; // For Mahalanobis warning level
        this.windowSize = parseInt(config.windowSize) || 100;
        this.minThreshold = config.minThreshold !== "" && config.minThreshold !== undefined ? parseFloat(config.minThreshold) : null;
        this.maxThreshold = config.maxThreshold !== "" && config.maxThreshold !== undefined ? parseFloat(config.maxThreshold) : null;
        
        // Correlation settings
        this.sensor1 = config.sensor1 || "sensor1";
        this.sensor2 = config.sensor2 || "sensor2";
        this.correlationThreshold = parseFloat(config.correlationThreshold) || 0.7;
        this.correlationMethod = config.correlationMethod || "pearson";
        
        // Advanced settings
        this.outputTopic = config.outputTopic || "";
        this.debug = config.debug === true;
        
        // State
        this.dataBuffers = {};
        
        // Debug logging helper
        var debugLog = function(message) {
            if (node.debug) {
                node.warn("[DEBUG] " + message);
            }
        };
        this.correlationBuffer1 = [];
        this.correlationBuffer2 = [];
        
        // Initial status
        node.status({fill: "blue", shape: "ring", text: node.mode + " mode"});
        
        // Helper functions
        function calculateMean(values) {
            return values.reduce((a, b) => a + b, 0) / values.length;
        }
        
        function calculateStdDev(values, mean) {
            var variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
            return Math.sqrt(variance);
        }
        
        function calculateZScore(value, values) {
            if (values.length < 2) return { zScore: 0, mean: value, stdDev: 0 };
            var mean = calculateMean(values);
            var stdDev = calculateStdDev(values, mean);
            var zScore = stdDev === 0 ? 0 : (value - mean) / stdDev;
            return { zScore: zScore, mean: mean, stdDev: stdDev };
        }
        
        function calculateIQR(values) {
            var sorted = values.slice().sort((a, b) => a - b);
            var q1Index = Math.floor(sorted.length * 0.25);
            var q3Index = Math.floor(sorted.length * 0.75);
            return {
                q1: sorted[q1Index],
                q3: sorted[q3Index],
                iqr: sorted[q3Index] - sorted[q1Index]
            };
        }
        
        function calculatePearsonCorrelation(x, y) {
            var n = x.length;
            if (n !== y.length || n === 0) return null;
            
            var meanX = calculateMean(x);
            var meanY = calculateMean(y);
            
            var covariance = 0;
            var stdX = 0;
            var stdY = 0;
            
            for (var i = 0; i < n; i++) {
                var dx = x[i] - meanX;
                var dy = y[i] - meanY;
                covariance += dx * dy;
                stdX += dx * dx;
                stdY += dy * dy;
            }
            
            stdX = Math.sqrt(stdX);
            stdY = Math.sqrt(stdY);
            
            if (stdX === 0 || stdY === 0) return 0;
            return covariance / (stdX * stdY);
        }
        
        function getRanks(values) {
            var indexed = values.map((value, index) => ({value, index}));
            indexed.sort((a, b) => a.value - b.value);
            
            var ranks = new Array(values.length);
            var i = 0;
            
            while (i < indexed.length) {
                var j = i;
                while (j < indexed.length && indexed[j].value === indexed[i].value) {
                    j++;
                }
                var avgRank = (i + j + 1) / 2;
                for (var k = i; k < j; k++) {
                    ranks[indexed[k].index] = avgRank;
                }
                i = j;
            }
            
            return ranks;
        }
        
        function calculateSpearmanCorrelation(x, y) {
            var ranksX = getRanks(x);
            var ranksY = getRanks(y);
            return calculatePearsonCorrelation(ranksX, ranksY);
        }
        
        // Cross-Correlation - finds time lag between two signals
        function calculateCrossCorrelation(x, y, maxLag) {
            var n = Math.min(x.length, y.length);
            maxLag = maxLag || Math.floor(n / 4);
            
            var meanX = calculateMean(x.slice(0, n));
            var meanY = calculateMean(y.slice(0, n));
            
            var stdX = calculateStdDev(x.slice(0, n), meanX);
            var stdY = calculateStdDev(y.slice(0, n), meanY);
            
            if (stdX === 0 || stdY === 0) {
                return { lag: 0, correlation: 0, correlations: [] };
            }
            
            var correlations = [];
            var maxCorr = -2;
            var bestLag = 0;
            
            // Calculate cross-correlation for each lag
            for (var lag = -maxLag; lag <= maxLag; lag++) {
                var sum = 0;
                var count = 0;
                
                for (var i = 0; i < n; i++) {
                    var j = i + lag;
                    if (j >= 0 && j < n) {
                        sum += (x[i] - meanX) * (y[j] - meanY);
                        count++;
                    }
                }
                
                var corr = count > 0 ? sum / (count * stdX * stdY) : 0;
                correlations.push({ lag: lag, correlation: corr });
                
                if (corr > maxCorr) {
                    maxCorr = corr;
                    bestLag = lag;
                }
            }
            
            return {
                lag: bestLag,
                correlation: maxCorr,
                correlations: correlations,
                interpretation: bestLag === 0 
                    ? "Signals are synchronized" 
                    : (bestLag > 0 
                        ? "Signal Y leads Signal X by " + bestLag + " samples"
                        : "Signal X leads Signal Y by " + (-bestLag) + " samples")
            };
        }
        
        // Mahalanobis distance calculation using ml-matrix (numerically stable)
        function calculateMahalanobisDistance(sample, mean, covMatrix) {
            var n = sample.length;
            
            // Calculate difference from mean
            var diff = [];
            for (var i = 0; i < n; i++) {
                diff.push(sample[i] - mean[i]);
            }
            
            // Use ml-matrix for robust matrix inversion if available
            if (Matrix) {
                try {
                    // Create Matrix objects
                    var covMat = new Matrix(covMatrix);
                    var diffVec = Matrix.columnVector(diff);
                    
                    // Add regularization to avoid singular matrix issues
                    var regularization = 1e-6;
                    for (var i = 0; i < n; i++) {
                        covMat.set(i, i, covMat.get(i, i) + regularization);
                    }
                    
                    // Use pseudoInverse for better numerical stability
                    var invCov = covMat.pseudoInverse();
                    
                    // Calculate (x-μ)' * Σ^-1 * (x-μ)
                    var temp = invCov.mmul(diffVec);
                    var d2 = diffVec.transpose().mmul(temp).get(0, 0);
                    
                    return Math.sqrt(Math.max(0, d2));
                } catch (err) {
                    // Fall back to manual implementation
                    debugLog("ml-matrix failed, using fallback: " + err.message);
                }
            }
            
            // Fallback: Manual implementation
            var invCov = invertMatrixFallback(covMatrix);
            if (!invCov) return null;
            
            // Calculate (x-μ)' * Σ^-1 * (x-μ)
            var temp = [];
            for (var i = 0; i < n; i++) {
                var sum = 0;
                for (var j = 0; j < n; j++) {
                    sum += diff[j] * invCov[j][i];
                }
                temp.push(sum);
            }
            
            var d2 = 0;
            for (var i = 0; i < n; i++) {
                d2 += temp[i] * diff[i];
            }
            
            return Math.sqrt(Math.max(0, d2));
        }
        
        // Fallback matrix inversion using Gauss-Jordan (for when ml-matrix is not available)
        function invertMatrixFallback(matrix) {
            var n = matrix.length;
            
            // Create augmented matrix [A|I]
            var aug = [];
            for (var i = 0; i < n; i++) {
                aug.push([]);
                for (var j = 0; j < n; j++) {
                    aug[i].push(matrix[i][j]);
                }
                for (var j = 0; j < n; j++) {
                    aug[i].push(i === j ? 1 : 0);
                }
            }
            
            // Gauss-Jordan elimination with partial pivoting
            for (var col = 0; col < n; col++) {
                // Find pivot
                var maxRow = col;
                for (var row = col + 1; row < n; row++) {
                    if (Math.abs(aug[row][col]) > Math.abs(aug[maxRow][col])) {
                        maxRow = row;
                    }
                }
                
                // Swap rows
                var temp = aug[col];
                aug[col] = aug[maxRow];
                aug[maxRow] = temp;
                
                // Check for singular matrix
                if (Math.abs(aug[col][col]) < 1e-10) {
                    // Add regularization
                    aug[col][col] += 1e-6;
                }
                
                // Scale pivot row
                var scale = aug[col][col];
                for (var j = 0; j < 2 * n; j++) {
                    aug[col][j] /= scale;
                }
                
                // Eliminate column
                for (var row = 0; row < n; row++) {
                    if (row !== col) {
                        var factor = aug[row][col];
                        for (var j = 0; j < 2 * n; j++) {
                            aug[row][j] -= factor * aug[col][j];
                        }
                    }
                }
            }
            
            // Extract inverse matrix
            var inv = [];
            for (var i = 0; i < n; i++) {
                inv.push([]);
                for (var j = 0; j < n; j++) {
                    inv[i].push(aug[i][n + j]);
                }
            }
            
            return inv;
        }
        
        // Calculate covariance matrix from buffer data
        function calculateCovarianceMatrix(dataBuffer, valueNames) {
            var n = valueNames.length;
            var m = dataBuffer.length;
            
            if (m < 2) return null;
            
            // Extract data by sensor
            var sensorData = {};
            valueNames.forEach(function(name) {
                sensorData[name] = [];
            });
            
            dataBuffer.forEach(function(sample) {
                valueNames.forEach(function(name, idx) {
                    if (sample[name] !== undefined) {
                        sensorData[name].push(sample[name]);
                    }
                });
            });
            
            // Calculate means
            var means = [];
            valueNames.forEach(function(name) {
                if (sensorData[name].length > 0) {
                    means.push(calculateMean(sensorData[name]));
                } else {
                    means.push(0);
                }
            });
            
            // Calculate covariance matrix
            var cov = [];
            for (var i = 0; i < n; i++) {
                cov.push([]);
                for (var j = 0; j < n; j++) {
                    var sum = 0;
                    var data_i = sensorData[valueNames[i]];
                    var data_j = sensorData[valueNames[j]];
                    
                    for (var k = 0; k < Math.min(data_i.length, data_j.length); k++) {
                        sum += (data_i[k] - means[i]) * (data_j[k] - means[j]);
                    }
                    
                    cov[i].push(sum / (m - 1));
                }
            }
            
            return { means: means, covariance: cov };
        }
        
        function calculateMedian(values) {
            var sorted = values.slice().sort((a, b) => a - b);
            var mid = Math.floor(sorted.length / 2);
            return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
        }
        
        // Aggregate mode - reduces multiple values to a single value
        function processAggregate(msg) {
            var values = [];
            var valueNames = [];
            
            if (Array.isArray(msg.payload)) {
                values = msg.payload.filter(v => typeof v === 'number' && !isNaN(v));
                valueNames = msg.valueNames || values.map((v, i) => "value" + i);
            } else if (typeof msg.payload === 'object' && msg.payload !== null) {
                Object.keys(msg.payload).forEach(key => {
                    var val = msg.payload[key];
                    if (typeof val === 'number' || (typeof val === 'string' && !isNaN(parseFloat(val)))) {
                        valueNames.push(key);
                        values.push(parseFloat(val));
                    }
                });
            } else {
                node.error("Payload must be an array or object for aggregation", msg);
                return null;
            }
            
            if (values.length === 0) {
                node.error("No valid values found for aggregation", msg);
                return null;
            }
            
            var result = {};
            var primaryValue;
            
            // Calculate aggregations
            var sum = values.reduce((a, b) => a + b, 0);
            var mean = sum / values.length;
            var min = Math.min.apply(null, values);
            var max = Math.max.apply(null, values);
            var range = max - min;
            var median = calculateMedian(values);
            var stdDev = calculateStdDev(values, mean);
            
            // Select primary value based on method
            switch (node.aggregateMethod) {
                case 'mean':
                    primaryValue = mean;
                    break;
                case 'median':
                    primaryValue = median;
                    break;
                case 'min':
                    primaryValue = min;
                    break;
                case 'max':
                    primaryValue = max;
                    break;
                case 'sum':
                    primaryValue = sum;
                    break;
                case 'range':
                    primaryValue = range;
                    break;
                case 'stddev':
                    primaryValue = stdDev;
                    break;
                default:
                    primaryValue = mean;
            }
            
            var outputMsg = node.preserveOriginal ? RED.util.cloneMessage(msg) : {};
            outputMsg.payload = primaryValue;
            outputMsg.aggregation = {
                method: node.aggregateMethod,
                value: primaryValue,
                count: values.length,
                all: {
                    mean: mean,
                    median: median,
                    min: min,
                    max: max,
                    sum: sum,
                    range: range,
                    stdDev: stdDev
                }
            };
            
            if (node.aggregateOutput === "all") {
                outputMsg.originalValues = values;
                outputMsg.valueNames = valueNames;
            }
            
            if (node.outputTopic) {
                outputMsg.topic = node.outputTopic;
            }
            
            debugLog("Aggregation: " + node.aggregateMethod + " = " + primaryValue.toFixed(4) + " (n=" + values.length + ")");
            
            node.status({
                fill: "green",
                shape: "dot",
                text: node.aggregateMethod + ": " + primaryValue.toFixed(2) + " (n=" + values.length + ")"
            });
            
            return { normal: outputMsg, anomaly: null };
        }
        
        // Split mode
        function processSplit(msg) {
            var sourceField = node.field === "payload" ? msg.payload : RED.util.getMessageProperty(msg, node.field);
            
            if (sourceField === undefined || sourceField === null) {
                node.error("Field '" + node.field + "' not found", msg);
                return null;
            }
            
            var values = [];
            var valueNames = [];
            
            if (Array.isArray(sourceField)) {
                values = sourceField;
                valueNames = values.map((v, i) => "value" + i);
            } else if (typeof sourceField === 'object' && sourceField !== null) {
                Object.keys(sourceField).forEach(key => {
                    var val = sourceField[key];
                    if (typeof val === 'number' || (typeof val === 'string' && !isNaN(parseFloat(val)))) {
                        valueNames.push(key);
                        values.push(parseFloat(val));
                    }
                });
            } else {
                var val = parseFloat(sourceField);
                if (!isNaN(val)) {
                    values = [val];
                    valueNames = ["value"];
                }
            }
            
            if (values.length === 0) {
                node.error("No valid numeric values found", msg);
                return null;
            }
            
            if (node.outputMode === "sequential") {
                values.forEach((value, index) => {
                    var newMsg = node.preserveOriginal ? RED.util.cloneMessage(msg) : {};
                    newMsg.payload = value;
                    newMsg.valueIndex = index;
                    newMsg.valueName = valueNames[index];
                    newMsg.totalValues = values.length;
                    node.send([newMsg, null]);
                });
                return null;
            } else {
                var outputMsg = node.preserveOriginal ? RED.util.cloneMessage(msg) : {};
                outputMsg.payload = values;
                outputMsg.valueNames = valueNames;
                outputMsg.valueCount = values.length;
                return { normal: outputMsg, anomaly: null };
            }
        }
        
        // Analyze mode
        function processAnalyze(msg) {
            var values = [];
            var valueNames = [];
            
            if (Array.isArray(msg.payload)) {
                values = msg.payload;
                valueNames = msg.valueNames || values.map((v, i) => "value" + i);
            } else if (typeof msg.payload === 'object' && msg.payload !== null) {
                Object.keys(msg.payload).forEach(key => {
                    var val = msg.payload[key];
                    if (typeof val === 'number' || (typeof val === 'string' && !isNaN(parseFloat(val)))) {
                        valueNames.push(key);
                        values.push(parseFloat(val));
                    }
                });
            } else {
                node.error("Payload must be an array or object", msg);
                return null;
            }
            
            if (values.length === 0) {
                node.error("No valid values found", msg);
                return null;
            }
            
            var results = [];
            var hasAnomaly = false;
            
            values.forEach((value, index) => {
                var valueName = valueNames[index] || ("value" + index);
                
                if (!node.dataBuffers[valueName]) {
                    node.dataBuffers[valueName] = [];
                }
                
                var buffer = node.dataBuffers[valueName];
                buffer.push({ timestamp: Date.now(), value: value });
                
                if (buffer.length > node.windowSize) {
                    buffer.shift();
                }
                
                var isAnomaly = false;
                var analysis = {
                    valueName: valueName,
                    value: value,
                    isAnomaly: false
                };
                
                if (buffer.length >= 2) {
                    var bufferValues = buffer.map(d => d.value);
                    
                    if (node.anomalyMethod === "zscore") {
                        var stats = calculateZScore(value, bufferValues);
                        analysis.zScore = stats.zScore;
                        analysis.mean = stats.mean;
                        analysis.stdDev = stats.stdDev;
                        isAnomaly = Math.abs(stats.zScore) > node.threshold;
                    } else if (node.anomalyMethod === "iqr") {
                        if (buffer.length >= 4) {
                            var iqr = calculateIQR(bufferValues);
                            var lowerBound = iqr.q1 - (1.5 * iqr.iqr);
                            var upperBound = iqr.q3 + (1.5 * iqr.iqr);
                            analysis.q1 = iqr.q1;
                            analysis.q3 = iqr.q3;
                            analysis.iqr = iqr.iqr;
                            isAnomaly = value < lowerBound || value > upperBound;
                        }
                    } else if (node.anomalyMethod === "threshold") {
                        if (node.minThreshold !== null && value < node.minThreshold) {
                            isAnomaly = true;
                            analysis.reason = "Below minimum";
                        }
                        if (node.maxThreshold !== null && value > node.maxThreshold) {
                            isAnomaly = true;
                            analysis.reason = analysis.reason ? analysis.reason + " and above maximum" : "Above maximum";
                        }
                    }
                }
                
                // Mahalanobis distance is calculated at the sample level (after loop)
                if (node.anomalyMethod === "mahalanobis") {
                    analysis.mahalanobisDeferred = true; // Will be calculated below
                }
                
                analysis.isAnomaly = isAnomaly;
                if (isAnomaly) hasAnomaly = true;
                results.push(analysis);
            });
            
            // Handle Mahalanobis distance (multivariate)
            if (node.anomalyMethod === "mahalanobis") {
                // Build historical data buffer for covariance calculation
                if (!node.mahalanobisBuffer) {
                    node.mahalanobisBuffer = [];
                }
                
                var sampleObj = {};
                values.forEach(function(val, idx) {
                    sampleObj[valueNames[idx]] = val;
                });
                node.mahalanobisBuffer.push(sampleObj);
                
                if (node.mahalanobisBuffer.length > node.windowSize) {
                    node.mahalanobisBuffer.shift();
                }
                
                if (node.mahalanobisBuffer.length >= 10) {
                    // Calculate covariance matrix
                    var covResult = calculateCovarianceMatrix(node.mahalanobisBuffer, valueNames);
                    
                    if (covResult) {
                        // Calculate Mahalanobis distance for current sample
                        var distance = calculateMahalanobisDistance(values, covResult.means, covResult.covariance);
                        
                        if (distance !== null) {
                            // Threshold based on chi-squared distribution
                            // For n dimensions at 95% confidence, threshold ≈ sqrt(n * 2.5)
                            var chiThreshold = Math.sqrt(values.length * node.threshold);
                            var chiWarningThreshold = Math.sqrt(values.length * node.warningThreshold);
                            
                            var severity = "normal";
                            if (distance > chiThreshold) {
                                severity = "critical";
                                hasAnomaly = true;
                            } else if (distance > chiWarningThreshold) {
                                severity = "warning";
                                hasAnomaly = true;
                            }
                            
                            // Add to all results
                            results.forEach(function(r) {
                                r.mahalanobisDistance = distance;
                                r.mahalanobisThreshold = chiThreshold;
                                r.mahalanobisWarningThreshold = chiWarningThreshold;
                                r.severity = severity;
                                r.isAnomaly = hasAnomaly;
                            });
                            
                            debugLog("Mahalanobis: d=" + distance.toFixed(4) + ", severity=" + severity + ", threshold=" + chiThreshold.toFixed(4) + ", anomaly=" + hasAnomaly);
                        }
                    }
                }
            }
            
            var outputMsg = RED.util.cloneMessage(msg);
            outputMsg.payload = results;
            outputMsg.hasAnomaly = hasAnomaly;
            outputMsg.anomalyCount = results.filter(r => r.isAnomaly).length;
            outputMsg.method = "multi-" + node.anomalyMethod;
            
            return { normal: hasAnomaly ? null : outputMsg, anomaly: hasAnomaly ? outputMsg : null };
        }
        
        // Correlate mode
        function processCorrelate(msg) {
            if (typeof msg.payload !== 'object' || msg.payload === null) {
                node.warn("Payload must be an object with sensor values");
                return null;
            }
            
            var value1 = parseFloat(msg.payload[node.sensor1]);
            var value2 = parseFloat(msg.payload[node.sensor2]);
            
            if (isNaN(value1) || isNaN(value2)) {
                node.warn("Missing or invalid sensor values: " + node.sensor1 + ", " + node.sensor2);
                return null;
            }
            
            node.correlationBuffer1.push(value1);
            node.correlationBuffer2.push(value2);
            
            if (node.correlationBuffer1.length > node.windowSize) {
                node.correlationBuffer1.shift();
                node.correlationBuffer2.shift();
            }
            
            if (node.correlationBuffer1.length < 3) {
                node.status({fill: "yellow", shape: "ring", text: "Buffering: " + node.correlationBuffer1.length + "/" + node.windowSize});
                return null;
            }
            
            var correlation = null;
            var crossCorr = null;
            
            if (node.correlationMethod === "pearson") {
                correlation = calculatePearsonCorrelation(node.correlationBuffer1, node.correlationBuffer2);
            } else if (node.correlationMethod === "spearman") {
                correlation = calculateSpearmanCorrelation(node.correlationBuffer1, node.correlationBuffer2);
            } else if (node.correlationMethod === "cross") {
                // Cross-correlation with time lag detection
                var maxLag = Math.floor(node.correlationBuffer1.length / 4);
                crossCorr = calculateCrossCorrelation(node.correlationBuffer1, node.correlationBuffer2, maxLag);
                correlation = crossCorr.correlation;
            }
            
            var isAnomalous = Math.abs(correlation) < node.correlationThreshold;
            
            var outputMsg = {
                payload: msg.payload,
                correlation: correlation,
                isAnomalous: isAnomalous,
                sensor1: node.sensor1,
                sensor2: node.sensor2,
                method: node.correlationMethod,
                stats: {
                    sensor1Mean: calculateMean(node.correlationBuffer1),
                    sensor2Mean: calculateMean(node.correlationBuffer2),
                    bufferSize: node.correlationBuffer1.length
                }
            };
            
            // Add cross-correlation specific output
            if (crossCorr) {
                outputMsg.crossCorrelation = {
                    bestLag: crossCorr.lag,
                    maxCorrelation: crossCorr.correlation,
                    interpretation: crossCorr.interpretation,
                    allLags: crossCorr.correlations
                };
            }
            
            Object.keys(msg).forEach(key => {
                if (key !== 'payload' && !outputMsg.hasOwnProperty(key)) {
                    outputMsg[key] = msg[key];
                }
            });
            
            var statusColor = isAnomalous ? "red" : "green";
            node.status({fill: statusColor, shape: "dot", text: "ρ=" + correlation.toFixed(3)});
            
            return { normal: isAnomalous ? null : outputMsg, anomaly: isAnomalous ? outputMsg : null };
        }
        
        node.on('input', function(msg) {
            try {
                if (msg.reset === true) {
                    node.dataBuffers = {};
                    node.correlationBuffer1 = [];
                    node.correlationBuffer2 = [];
                    node.status({fill: "blue", shape: "ring", text: node.mode + " - reset"});
                    return;
                }
                
                var result = null;
                
                switch (node.mode) {
                    case "split":
                        result = processSplit(msg);
                        break;
                    case "analyze":
                        result = processAnalyze(msg);
                        break;
                    case "correlate":
                        result = processCorrelate(msg);
                        break;
                    case "aggregate":
                        result = processAggregate(msg);
                        break;
                    default:
                        result = processSplit(msg);
                }
                
                if (result) {
                    if (result.anomaly) {
                        node.send([null, result.anomaly]);
                    } else if (result.normal) {
                        node.send([result.normal, null]);
                    }
                }
                
            } catch (err) {
                node.status({fill: "red", shape: "ring", text: "error"});
                node.error("Error in multi-value processing: " + err.message, msg);
            }
        });
        
        node.on('close', function() {
            node.dataBuffers = {};
            node.correlationBuffer1 = [];
            node.correlationBuffer2 = [];
            node.status({});
        });
    }
    
    RED.nodes.registerType("multi-value-processor", MultiValueProcessorNode);
};
