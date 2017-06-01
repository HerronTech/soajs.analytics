/* jshint esversion: 6 */
'use strict';
const async = require('async');
const step = require('../functions/initialize.js');
const deactivate = require('../functions/deactivate.js');
const utils = require('../utils/utils');
const collection = {
	analytics: 'analytics'
};

let tracker = {};
const script = {
	"checkAnalytics": function (settings, env, cb) {
		const date = new Date().getTime();
		let data = {};
		// return tracker ready
		let activated = false;
		if (settings && settings.env) {
			activated = utils.getActivatedEnv(settings, env);
		}
		if (settings && settings.env && settings.env[env]) {
			if (!(tracker[env] && tracker[env].info && tracker[env].info.status)) {
				tracker[env] = {
					"info": {
						"status": "ready",
						"ts": date
					}
				};
				data[env] = true;
				data.tracker = tracker[env];
				data.activated = activated;
			}
			else {
				data.tracker = tracker[env];
				data[env] = true;
				data.activated = activated;
			}
		}
		else {
			data.tracker = tracker[env] || {};
			data[env] = false;
			data.activated = activated;
			
		}
		if (settings) {
			if (settings.kibana) {
				data.kibana = settings.kibana;
			}
			if (settings.elasticsearch) {
				data.elasticsearch = settings.elasticsearch;
			}
		}
		return cb(null, data);
	},
	
	"initialize": function (opts, mode, cb) {
		let data = {};
		let date = new Date().getTime();
		let env = opts.envRecord.code.toLowerCase();
		if (mode === "dashboard" && opts.settings && opts.settings.env && opts.settings.env[env]) {
			tracker[env] = {
				"info": {
					"status": "ready",
					"ts": date
				}
			};
			data[env] = true;
			data.tracker = tracker[env];
			return cb(null, data);
		}
		else if (mode === "dashboard" && tracker[env] && tracker[env].info && tracker[env].info.status && tracker[env].info.status === "started") {
			data.tracker = tracker[env] || {};
			data[env] = false;
			return cb(null, data);
		}
		else {
			tracker[env] = {
				"info": {
					"status": "started",
					"ts": date
				}
			};
		}
		function returnTracker() {
			if (mode === "dashboard") {
				tracker[env] = {
					"info": {
						"status": "started",
						"ts": date
					}
				};
				data.tracker = tracker[env];
				data[env] = false;
				return cb(null, data);
			}
		}
		
		returnTracker();
		
		let operations = {
		 //	insertMongoData: async.apply(step.test, opts.soajs, opts.model),
			insertMongoData: async.apply(step.insertMongoData, opts.soajs, opts.model),
			deployElastic: ['insertMongoData', async.apply(step.deployElastic, opts.soajs, opts.config, mode, opts.deployment, opts.envRecord, opts.model)],
			pingElasticsearch: ['deployElastic', async.apply(step.pingElasticsearch, opts.esClient)],
			getElasticClientNode: ['pingElasticsearch', async.apply(step.getElasticClientNode, opts.esClient, opts.esCluster)],
			setMapping: ['getElasticClientNode', async.apply(step.setMapping, opts.soajs, opts.model, opts.esClient)],
			addVisualizations: ['setMapping', async.apply(step.addVisualizations, opts.soajs, opts.deployment, opts.esClient, opts.envRecord, opts.model)],
			deployKibana: ['addVisualizations', async.apply(step.deployKibana, opts.soajs, opts.config, opts.catalogDeployment, opts.deployment, opts.envRecord, opts.model)],
			deployLogstash: ['deployKibana', async.apply(step.deployLogstash, opts.soajs, opts.config, opts.catalogDeployment, opts.deployment, opts.envRecord, opts.model, opts.esCluster)],
			deployFilebeat: ['deployLogstash', async.apply(step.deployFilebeat, opts.soajs, opts.config, opts.deployment, opts.envRecord, opts.model)],
			deployMetricbeat: ['deployFilebeat', async.apply(step.deployMetricbeat, opts.soajs, opts.config, opts.catalogDeployment, opts.deployment, opts.envRecord, opts.model, opts.esCluster)],
			checkAvailability: ['deployMetricbeat', async.apply(step.checkAvailability, opts.soajs, opts.deployment, opts.envRecord, opts.model)],
			setDefaultIndex: ['checkAvailability', async.apply(step.setDefaultIndex, opts.soajs, opts.deployment, opts.esClient, opts.envRecord, opts.model)],
		 };
		
		async.auto(operations, function (err) {
			if (err) {
				if (mode === "installer") {
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
				if (mode === "installer") {
					return cb(null, true);
				}
				else {
					return null;
				}
			}
		});
	},
	
	"deactivate": function (soajs, env, model, cb) {
		let combo = {};
		combo.collection = collection.analytics;
		combo.conditions = {
			"_type": "settings"
		};
		const environment = env.code.toLowerCase();
		model.findEntry(soajs, combo, function (err, settings) {
			if (err) {
				return cb(err);
			}
			const options = utils.buildDeployerOptions(env, soajs, model);
			const activated = utils.getActivatedEnv(settings, env);
			deactivate.deleteService(options, environment, activated, function (error) {
				if (error) {
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
					if (error) {
						return cb(error);
					}
					tracker = {};
					return cb(null, true);
				});
			})
			
		});
	},
	
	"deployElastic": function (opts, mode, config, cb) {
		async.parallel({
			deploy: function (call) {
				step.deployElastic(opts.soajs, opts.config, mode, opts.dashboard, opts.envRecord, opts.model, null, call)
			},
			updateDb: function (call) {
				utils.addEsClusterToDashboard(opts.soajs, opts.model, config, opts.dashboard, opts.envRecord, opts.settings, call)
			}
		}, function (err, response){
			console.log("-----------------------------------------------------------------")
			console.log("-----------------------------------------------------------------")
			console.log("-----------------------------------------------------------------")
			console.log(err)
			console.log("ELasticsearch has been deployed")
			console.log("-----------------------------------------------------------------")
			console.log("-----------------------------------------------------------------")
			console.log("-----------------------------------------------------------------")
			if(err){
				return cb(err);
			}
			else{
				opts.soajs.log.warn("ELasticsearch has been deployed...");
				return cb(null, response);
			}
		});
	}
	
};

module.exports = script;
