/* jshint esversion: 6 */
'use strict';
const async = require('async');
let step = require('../functions/index.js');
const script = {
	"initialize": function (opts, cb) {
		let operations = [];
		operations.push(async.apply(step.insertMongoData, opts.soajs, opts.model));
		operations.push(async.apply(step.deployElastic, opts.soajs, opts.deployment, opts.envRecord, opts.model));
		operations.push(async.apply(step.checkElasticSearch, opts.esClient));
		operations.push(async.apply(step.setMapping, opts.soajs, opts.model, opts.esClient));
		operations.push(async.apply(step.addVisualizations, opts.soajs, opts.deployment, opts.esClient, opts.envRecord, opts.model));
		operations.push(async.apply(step.deployKibana, opts.soajs, opts.deployment, opts.envRecord, opts.model));
		operations.push(async.apply(step.deployLogstash, opts.soajs, opts.deployment, opts.envRecord, opts.model));
		operations.push(async.apply(step.deployFilebeat, opts.soajs, opts.deployment, opts.envRecord, opts.model));
		operations.push(async.apply(step.deployMetricbeat, opts.soajs, opts.deployment, opts.envRecord, opts.model));
		operations.push(async.apply(step.checkAvailability, opts.soajs, opts.deployment, opts.envRecord, opts.model));
		operations.push(async.apply(step.setDefaultIndex, opts.soajs, opts.deployment, opts.esClient, opts.envRecord, opts.model));
		async.series(operations, function (err) {
			if (err) {
				if (cb && typeof cb === "function") {
					return cb(err);
				}
				else {
					console.log(err)
					return null;
				}
			}
			else {
				//close es connection
				opts.esClient.close();
				console.log("Analytics deployed");
				if (cb && typeof cb === "function") {
					return cb(null, true);
				}
				else {
					return null;
				}
			}
		});
	}
};

module.exports = script;