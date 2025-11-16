# Release Checklist v0.1.0

## ✅ Pre-Release Preparation (COMPLETED)

### Core Files
- [x] All 17 nodes implemented and functional
- [x] All nodes translated to English
- [x] Icons configured (separate for anomaly detection & predictive maintenance)
- [x] All nodes colored yellow (#FDD835)
- [x] Categories properly set (anomaly detection, predictive maintenance)

### Documentation
- [x] README.md with comprehensive documentation
- [x] CHANGELOG.md with v0.1.0 details
- [x] LICENSE file (MIT)
- [x] 5 example flows in /examples
- [x] examples/README.md with detailed explanations
- [x] examples/IMPORT_GUIDE.md for users
- [x] NODE_COVERAGE.md showing all nodes are used
- [x] PAYLOAD_FORMAT.md for data structures
- [x] MULTI_VALUE.md for multi-sensor usage
- [x] Beta status warning in README

### Package Configuration
- [x] package.json properly configured
- [x] Version set to 0.1.0
- [x] Repository URL: https://github.com/blanpa/node-red-contrib-condition-monitoring.git
- [x] Homepage URL configured
- [x] Bugs URL configured
- [x] All 17 nodes registered in package.json
- [x] Dependencies listed (ml-isolation-forest, simple-statistics)
- [x] Keywords optimized for npm search
- [x] Node.js version requirement: >=14.0.0
- [x] main field removed (not needed for Node-RED)

### Build & Deploy Files
- [x] .npmignore created (excludes dev files)
- [x] .gitignore created
- [x] Docker setup (dev & prod)

---

## 📦 Release Steps

### 1. Git Repository Setup
```bash
# Initialize git (if not done)
cd /home/la/private/node-red-contrib-condition-monitoring
git init

# Add all files
git add .

# Initial commit
git commit -m "Initial release v0.1.0

- 10 anomaly detection nodes
- 7 predictive maintenance nodes
- Complete documentation
- 5 example flows
- Docker development environment
"

# Add remote (if not done)
git remote add origin https://github.com/blanpa/node-red-contrib-condition-monitoring.git

# Push to GitHub
git branch -M main
git push -u origin main

# Tag the release
git tag -a v0.1.0 -m "Release v0.1.0 - Initial Beta Release"
git push origin v0.1.0
```

### 2. npm Publishing

#### Test the package first:
```bash
# Dry run to see what will be published
npm publish --dry-run

# Check package contents
npm pack
tar -tzf node-red-contrib-condition-monitoring-0.1.0.tgz

# Clean up
rm node-red-contrib-condition-monitoring-0.1.0.tgz
```

#### Login to npm (if not done):
```bash
npm login
# Follow prompts
```

#### Publish to npm:
```bash
# Publish as public package
npm publish --access public

# Or for beta tag (optional):
# npm publish --tag beta --access public
```

### 3. Create GitHub Release

1. Go to: https://github.com/blanpa/node-red-contrib-condition-monitoring/releases/new
2. Tag: `v0.1.0`
3. Title: `v0.1.0 - Initial Beta Release`
4. Description:

```markdown
## 🎉 Initial Beta Release

This is the first public release of node-red-contrib-condition-monitoring!

### 📊 Features

**Anomaly Detection (10 Nodes):**
- Z-Score, IQR, Moving Average, Isolation Forest
- Threshold, Percentile, EMA, CUSUM
- Multi-Value Anomaly, Multi-Value Splitter

**Predictive Maintenance (7 Nodes):**
- Trend Prediction (RUL calculation)
- FFT Analysis (frequency domain)
- Vibration Features (RMS, Crest Factor, Kurtosis, Skewness)
- Health Index (multi-sensor aggregation)
- Rate of Change (derivative analysis)
- Peak Detection (impact counting)
- Correlation Anomaly (sensor validation)

### 📦 Installation

```bash
npm install node-red-contrib-condition-monitoring
```

Or install directly in Node-RED: `Menu → Manage palette → Install`

### 📖 Documentation

- [README](README.md) - Complete documentation
- [Examples](examples/README.md) - 5 ready-to-use flows
- [Import Guide](examples/IMPORT_GUIDE.md) - Getting started

### 🚧 Beta Status

This is a beta release. All features are functional but undergoing real-world validation.
- API may change before v1.0
- Feedback welcome!
- Report issues: https://github.com/blanpa/node-red-contrib-condition-monitoring/issues

### 🙏 Feedback Welcome

Please try it out and let us know:
- What works well
- What could be improved
- Any bugs or issues
- Feature requests

**Happy Monitoring! 🎉**
```

5. Attach files (optional):
   - None needed (npm package is sufficient)

6. Click "Publish release"

---

## 🧪 Post-Release Testing

### Verify npm package:
```bash
# Install from npm in fresh directory
mkdir test-install
cd test-install
npm init -y
npm install node-red-contrib-condition-monitoring

# Check files
ls node_modules/node-red-contrib-condition-monitoring/

# Verify it works
node-red
# Open http://localhost:1880
# Check if nodes appear in palette
```

### Verify GitHub:
- [ ] Repository is public
- [ ] README displays correctly
- [ ] All files are there
- [ ] Release tag visible
- [ ] Issues enabled

### Update npm badges in README (after publish):
The npm version badge will now work:
```markdown
[![npm version](https://img.shields.io/npm/v/node-red-contrib-condition-monitoring.svg)](https://www.npmjs.com/package/node-red-contrib-condition-monitoring)
```

---

## 📢 Announcement (Optional)

### Node-RED Forum
Post in: https://discourse.nodered.org/c/announcements/8

```markdown
# New Package: node-red-contrib-condition-monitoring

I'm happy to announce the first beta release of node-red-contrib-condition-monitoring!

**What it does:**
Complete toolkit for anomaly detection and predictive maintenance with 17 specialized nodes.

**Key Features:**
- 10 anomaly detection methods (Z-Score, IQR, Isolation Forest, CUSUM, etc.)
- 7 predictive maintenance nodes (RUL prediction, FFT analysis, vibration features)
- 5 ready-to-use example flows
- Comprehensive documentation

**Installation:**
npm install node-red-contrib-condition-monitoring

**Links:**
- npm: https://www.npmjs.com/package/node-red-contrib-condition-monitoring
- GitHub: https://github.com/blanpa/node-red-contrib-condition-monitoring
- Documentation: See README

Feedback welcome! 🎉
```

### Reddit r/nodered (Optional)
Similar announcement

### Twitter/X (Optional)
```
🎉 Just released node-red-contrib-condition-monitoring v0.1.0!

17 nodes for anomaly detection & predictive maintenance
- RUL prediction
- FFT analysis  
- Vibration monitoring
- Health scoring

npm: npmjs.com/package/node-red-contrib-condition-monitoring
#nodered #iiot #predictivemaintenance
```

---

## 📋 Quick Command Summary

```bash
# 1. Git setup
git init
git add .
git commit -m "Initial release v0.1.0"
git remote add origin https://github.com/blanpa/node-red-contrib-condition-monitoring.git
git push -u origin main
git tag v0.1.0
git push origin v0.1.0

# 2. npm test
npm publish --dry-run

# 3. npm publish
npm login
npm publish --access public

# 4. Verify
npm view node-red-contrib-condition-monitoring
```

---

## ✅ Final Checklist

Before hitting publish:

- [ ] All files committed to git
- [ ] Pushed to GitHub
- [ ] GitHub repository is public
- [ ] npm account ready
- [ ] npm publish --dry-run looks good
- [ ] Double-checked version number (0.1.0)
- [ ] README looks good on GitHub
- [ ] Examples are accessible

**Ready to publish!** 🚀

---

## 📞 Support

After release, monitor:
- GitHub issues
- npm package downloads
- User feedback
- Bug reports

Respond to issues within 48 hours when possible.

---

**Version:** 0.1.0  
**Date:** 2024-11-16  
**Status:** READY FOR RELEASE ✅

