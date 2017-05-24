/* jshint esversion: 6 */
'use strict';
const async = require('async');
const step = require('../functions/initialize.js');
const deactivate =  require('../functions/deactivate.js');
const utils = require('../utils/utils');
const collection = {
	analytics: 'analytics'
};


const script = {
	"checkAnalytics": function (){},
	
	"initialize": function (opts, cb) {
		
		let operations = [];
		operations.push(async.apply(step.insertMongoData, opts.soajs, opts.model));
		operations.push(async.apply(step.deployElastic, opts.soajs, opts.deployment, opts.envRecord, opts.mode, opts.es_external));
		operations.push(async.apply(step.checkElasticSearch, opts.esClient));
		operations.push(async.apply(step.getElasticClientNode, opts.esClient));
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
					console.log(err);
					return cb(err);
				}
				else {
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
	},
	
	"deactivate": function (soajs, env, model, tracker, cb) {
		let combo = {};
		combo.collection = collection.analytics;
		combo.conditions = {
			"_type": "settings"
		};
		const environment = env.code.toLowerCase();
		model.findEntry(soajs, combo, function (err, settings){
			if(err){
				return cb(err);
			}
			const options = utils.buildDeployerOptions(env, soajs, model);
			const activated = utils.getActivatedEnv(settings, env);
			deactivate.deleteService(options, environment, activated, function (error) {
				if (error){
					return cb(error);
				}
				if (!settings) {
					tracker = {};
					return cb(null, true);
				}
				
				if (settings.env && settings.env[environment]) {
					settings.env[environment] = false;
				}
				
				if (settings.logstash && settings.logstash[environment]) {
					delete settings.logstash[environment];
				}
				
				if (settings.filebeat && settings.filebeat[environment]) {
					delete settings.filebeat[environment];
				}
				
				if (settings.metricbeat && !activated) {
					delete settings.metricbeat;
				}
				if (settings.kibana && !activated) {
					delete settings.kibana;
				}
				
				//save
				let comboS = {};
				comboS.collection = collection.analytics;
				comboS.record = settings;
				model.saveEntry(soajs, comboS, function (error) {
					if(error){
						return cb(error);
					}
					tracker = {};
					return cb(null, true);
				});
			})
			
		});
	}
	
};

module.exports = script;
