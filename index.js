/* jshint esversion: 6 */
'use strict';
const model = require('./utils/mongo');
const script = require('./script/index.js');

module.exports = {
  checkAnalytics(opts, cb) {
    script.checkAnalytics(opts, cb);
  },

  activateAnalytics(opts, cb) {
    if (!opts.model) {
      opts.model = model;
    }
    if (!opts.deployment) {
      opts.deployment = {};
    }
    // in case of installer
    if (!opts.config) {
      opts.config = {};
    }
    // in case of installer
    if (!opts.catalogDeployment) {
      opts.catalogDeployment = {};
    }
    script.initialize(opts, (err) => {
      if (cb && typeof cb === 'function') {
        if (err) {
          return cb(err);
        }
        return cb(null, true);
      }
      return null;
    });
  },

  deactivateAnalytics(opts, cb) {
    script.deactivate(opts, cb);
  }
};
