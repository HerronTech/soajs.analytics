/* jshint esversion: 6 */
"use strict";

const model = require('./utils/mongo');
const script = require("./script/index.js");
const config = require("./config.js");

module.exports = {
	"checkAnalytics": function(opts, cb){
		script.checkAnalytics(opts.settings, opts.env, cb);
	},
	"activateAnalytics": function (opts, mode, cb) {
		if (!opts.model) {
			opts.model = model;
		}
		if (!opts.deployment) {
			opts.deployment = {};
		}
		//in case of installer
		if (!opts.config) {
			opts.config = {};
		}
		//in case of installer
		if (!opts.catalogDeployment) {
			opts.catalogDeployment = {};
		}
		script.initialize(opts, mode, function (err) {
			if (cb && typeof cb === "function") {
				if (err) {
					return cb(err);
				}
				else {
					return cb(null, true);
				}
			}
			else {
				return null;
			}
		});
	},
	
	"deactivateAnalytics": function (opts, tracker, cb) {
		script.deactivate(opts.soajs, opts.envRecord, opts.model, tracker, cb);
	},
	
	"deployElastic": function (opts, mode, cb) {
		if (!opts.catalogDeployment) {
			opts.catalogDeployment = {};
		}
		script.deployElastic(opts, mode, config, cb);
	}
};