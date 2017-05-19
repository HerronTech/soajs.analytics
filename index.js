/* jshint esversion: 6 */
"use strict";

const model = require('./utils/mongo');
let script = require("./script/index.js");

module.exports = {
	"activateAnalytics": function (opts, cb) {
		if (!opts.model){
			opts.model = model;
		}
		script.initialize(opts, function (err) {
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
	"deactivateAnalytics": function (opts, cb) {
	
	}
};