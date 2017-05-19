/* jshint esversion: 6 */
"use strict";
const fs = require('fs');
const async = require('async');
const request = require("request");
//const deployer = require('soajs').drivers;
const deployer = require('soajs.core.drivers');
const utils = require('../utils/utils');
const collection = {
	analytics: 'analytics'
};
const uuid = require('uuid');
const filebeatIndex = require("../data/indexes/filebeat-index");
const metricbeatIndex = require("../data/indexes/metricbeat-index");
let counter = 0;
const lib = {
	/**
	 * insert analytics data to mongo
	 * @param {object} soajs: object in req
	 * @param {object} model: Mongo object
	 * @param {function} cb: callback function
	 */
	"insertMongoData": function (soajs, model, cb) {
		let comboFind = {};
		comboFind.collection = collection.analytics;
		comboFind.conditions = {
			"_type": "settings"
		};
		model.findEntry(soajs, comboFind, function (error, response) {
			if (error) {
				return cb(error);
			}
			let records = [];
			
			function importData(records, call) {
				let dataFolder = __dirname + "/data/";
				fs.readdir(dataFolder, function (err, items) {
					async.forEachOf(items, function (item, key, callback) {
						if (key === 0) {
							records = require(dataFolder + items[key]);
						}
						else {
							let arrayData = require(dataFolder + item);
							if (Array.isArray(arrayData) && arrayData.length > 0) {
								records = records.concat(arrayData)
							}
						}
						callback();
					}, function () {
						let comboInsert = {};
						comboInsert.collection = collection.analytics;
						comboInsert.record = records;
						if (records) {
							model.insertEntry(soajs, comboInsert, call);
						}
						else {
							return call(null, true);
						}
					});
				});
			}
			
			if (response && response.mongoImported) {
				return cb(null, true);
			}
			else {
				importData(records, function (err) {
					if (err) {
						return cb(err);
					}
					else {
						let combo = {
							"collection": collection.analytics,
							"conditions": {
								"_type": "settings"
							},
							"fields": {
								"$set": {
									"mongoImported": true
								}
							},
							"options": {
								"safe": true,
								"multi": false,
								"upsert": false
							}
						};
						model.updateEntry(soajs, combo, cb);
					}
				});
			}
		})
	},
	
	/**
	 * create deployment object
	 * @param {string} service: elk file name
	 * @param {object} deployment: deployment object
	 * @param {object} env: environment object
	 * @param {function} cb: callback function
	 */
	"getAnalyticsContent": function (service, deployment, env, cb) {
		let path = __dirname + "/../data/services/elk/";
		fs.exists(path, function (exists) {
			if (!exists) {
				return cb('Folder [' + path + '] does not exist');
			}
			let loadContent;
			try {
				loadContent = require(path + service);
			}
			catch (e) {
				return cb(e);
			}
			let serviceParams = {
				"env": loadContent.env,
				"name": loadContent.name,
				"image": loadContent.deployConfig.image,
				"imagePullPolicy": "IfNotPresent",
				"variables": loadContent.variables || [],
				"labels": loadContent.labels,
				"memoryLimit": loadContent.deployConfig.memoryLimit,
				"replication": {
					"mode": loadContent.deployConfig.replication.mode,
					"replicas": loadContent.deployConfig.replication.replicas
				},
				"containerDir": loadContent.deployConfig.workDir,
				"restartPolicy": {
					"condition": loadContent.deployConfig.restartPolicy.condition,
					"maxAttempts": loadContent.deployConfig.restartPolicy.maxAttempts
				},
				"network": loadContent.deployConfig.network,
				"ports": loadContent.deployConfig.ports || []
			};
			
			if (loadContent.command && loadContent.command.cmd) {
				serviceParams.command = loadContent.command.cmd;
			}
			if (loadContent.command && loadContent.command.args) {
				serviceParams.args = loadContent.command.args;
			}
			//if deployment is kubernetes
			let esNameSpace = '';
			let logNameSpace = '';
			if (env.deployer.selected.split(".")[1] === "kubernetes") {
				//"soajs.service.mode": "deployment"
				if (serviceParams.labels["soajs.service.mode"] === "replicated") {
					serviceParams.labels["soajs.service.mode"] = "deployment";
				}
				else {
					serviceParams.labels["soajs.service.mode"] = "daemonset";
				}
				if (serviceParams.memoryLimit) {
					delete serviceParams.memoryLimit;
				}
				if (serviceParams.replication.mode === "replicated") {
					serviceParams.replication.mode = "deployment";
				}
				else if (serviceParams.replication.mode === "global") {
					serviceParams.replication.mode = "daemonset";
				}
				esNameSpace = '-service.' + env.deployer.container["kubernetes"][env.deployer.selected.split('.')[2]].namespace.default;
				logNameSpace = '-service.' + env.deployer.container["kubernetes"][env.deployer.selected.split('.')[2]].namespace.default;
				
				if (env.deployer.container["kubernetes"][env.deployer.selected.split('.')[2]].namespace.perService) {
					esNameSpace += '-soajs-analytics-elasticsearch-service';
					logNameSpace += '-' + env.code.toLowerCase() + '-logstash-service';
				}
				//change published port name
				if (service === "elastic") {
					serviceParams.ports[0].published = 30920;
				}
			}
			if (loadContent.deployConfig.volume) {
				if (env.deployer.selected.split(".")[1] === "kubernetes") {
					serviceParams.voluming = {
						"volumes": [],
						"volumeMounts": []
					};
					loadContent.deployConfig.volume.forEach(function (oneVolume) {
						serviceParams.voluming.volumes.push({
							"name": oneVolume.Source,
							"hostPath": {
								"path": oneVolume.Target
							}
						});
						serviceParams.voluming.volumeMounts.push({
							"name": oneVolume.Source,
							"mountPath": oneVolume.Target
						});
					})
				}
				else if (env.deployer.selected.split(".")[1] === "docker") {
					if (service === "metricbeat") {
						loadContent.deployConfig.volume[0].Source = loadContent.deployConfig.volume[0].Target;
					}
					serviceParams.voluming = {
						"volumes": loadContent.deployConfig.volume
					};
				}
			}
			if (loadContent.deployConfig.annotations) {
				serviceParams.annotations = loadContent.deployConfig.annotations;
			}
			serviceParams = JSON.stringify(serviceParams);
			//add namespace
			if (service === "logstash" || service === "metricbeat" || service === "kibana") {
				serviceParams = serviceParams.replace(/%esNameSpace%/g, esNameSpace);
			}
			if (service === "filebeat") {
				serviceParams = serviceParams.replace(/%logNameSpace%/g, logNameSpace);
			}
			serviceParams = serviceParams.replace(/%env%/g, env.code.toLowerCase());
			serviceParams = JSON.parse(serviceParams);
			serviceParams.deployment = deployment;
			return cb(null, serviceParams);
		});
	},
	
	/**
	 * deploy elasticsearch
	 * @param {object} soajs: elk file name
	 * @param {object} deployment: deployment object
	 * @param {object} env: environment object
	 * @param {object} model: mongo object
	 * @param {function} cb: callback function
	 */
	"deployElastic": function (soajs, deployment, env, model, cb) {
		console.log("Deploying ElasticSearch ...")
		let combo = {};
		combo.collection = collection.analytics;
		combo.conditions = {
			"_type": "settings"
		};
		model.findEntry(soajs, combo, function (error, settings) {
			if (error) {
				return cb(error);
			}
			if (settings && settings.elasticsearch &&
				//either elastic is deployed or its external
				(settings.elasticsearch.external || settings.elasticsearch.status === "deployed")) {
				return cb(null, true)
			}
			else {
				lib.getAnalyticsContent("elastic", deployment, env, function (err, content) {
					if (err) {
						return cb(err);
					}
					let options = utils.buildDeployerOptions(env, soajs, model);
					options.params = content;
					async.parallel({
						"deploy": function (call) {
							deployer.deployService(options, call);
						},
						"update": function (call) {
							//Todo fix this
							settings.elasticsearch.status = "deployed";
							combo.record = settings;
							model.saveEntry(soajs, combo, call);
						}
					}, cb);
				});
			}
		});
	},
	
	/**
	 * ping elasticsearch
	 * @param {object} esClient: cluster info
	 * @param {object} soajs: soajs object in req
	 * @param {function} cb: callback function
	 */
	"pingElastic": function (esClient, cb) {
		esClient.ping(function (error) {
			if (error) {
				setTimeout(function () {
					if (counter > 150) { // wait 5 min
						cb(error);
					}
					counter++;
					lib.pingElastic(esClient, cb);
				}, 2000);
			}
			else {
				lib.infoElastic(esClient, cb)
			}
		});
	},
	
	/**
	 * check if elasticsearch is ready
	 * @param {object} esClient: cluster info
	 * @param {function} cb: callback function
	 */
	"infoElastic": function (esClient, cb) {
		esClient.db.info(function (error) {
			if (error) {
				setTimeout(function () {
					lib.infoElastic(esClient, cb);
				}, 3000);
			}
			else {
				return cb(null, true);
			}
		});
	},
	
	/**
	 * check elasticsearch overall availability
	 * @param {object} esClient: cluster info
	 * @param {object} soajs: soajs object in req
	 * @param {function} cb: callback function
	 */
	"checkElasticSearch": function (esClient, cb) {
		console.log("Checking ElasticSearch Availablity...")
		lib.pingElastic(esClient, cb);
		//add version to settings record
	},
	
	/**
	 * add mappings and templates to es
	 * @param {object} soajs: soajs object in req
	 * @param {object} model: Mongo object
	 * @param {object} esClient: cluster info
	 * @param {function} cb: callback function
	 */
	"setMapping": function (soajs, model, esClient, cb) {
		console.log("Adding Mapping and templates");
		async.series({
			"mapping": function (callback) {
				lib.putMapping(soajs, model, esClient, callback);
			},
			"template": function (callback) {
				lib.putTemplate(soajs, model, esClient, callback);
			}
		}, cb);
	},
	
	/**
	 * add templates to es
	 * @param {object} soajs: soajs object in req
	 * @param {object} model: Mongo object
	 * @param {object} esClient: cluster info
	 * @param {function} cb: callback function
	 */
	"putTemplate": function (soajs, model, esClient, cb) {
		let combo = {
			collection: collection.analytics,
			conditions: {_type: 'template'}
		};
		model.findEntries(soajs, combo, function (error, templates) {
			if (error) return cb(error);
			async.each(templates, function (oneTemplate, callback) {
				if (oneTemplate._json.dynamic_templates && oneTemplate._json.dynamic_templates["system-process-cgroup-cpuacct-percpu"]) {
					oneTemplate._json.dynamic_templates["system.process.cgroup.cpuacct.percpu"] = oneTemplate._json.dynamic_templates["system-process-cgroup-cpuacct-percpu"];
					delete oneTemplate._json.dynamic_templates["system-process-cgroup-cpuacct-percpu"];
				}
				oneTemplate._json.settings["index.mapping.total_fields.limit"] = oneTemplate._json.settings["index-mapping-total_fields-limit"];
				oneTemplate._json.settings["index.refresh_interval"] = oneTemplate._json.settings["index-refresh_interval"];
				delete oneTemplate._json.settings["index-refresh_interval"];
				delete oneTemplate._json.settings["index-mapping-total_fields-limit"];
				let options = {
					'name': oneTemplate._name,
					'body': oneTemplate._json
				};
				esClient.db.indices.putTemplate(options, callback);
			}, cb);
		});
	},
	
	/**
	 * add mappings to es
	 * @param {object} soajs: soajs object in req
	 * @param {object} model: Mongo object
	 * @param {object} esClient: cluster info
	 * @param {function} cb: callback function
	 */
	"putMapping": function (soajs, model, esClient, cb) {
		let combo = {
			collection: collection.analytics,
			conditions: {_type: 'mapping'}
		};
		model.findEntries(soajs, combo, function (error, mappings) {
			if (error) return cb(error);
			let mapping = {
				index: '.kibana',
				body: mappings._json
			};
			esClient.db.indices.exists(mapping, function (error, result) {
				if (error || !result) {
					esClient.db.indices.create(mapping, function (err) {
						return cb(err, true);
					});
				}
				else {
					return cb(null, true);
				}
			});
		});
	},
	
	/**
	 * add kibana visualizations to es
	 * @param {object} soajs: soajs object in req
	 * @param {object} deployment: deployment object
	 * @param {object} esClient: cluster info
	 * @param {object} env: environment object
	 * @param {object} model: Mongo object
	 * @param {function} cb: callback function
	 */
	"addVisualizations": function (soajs, deployment, esClient, env, model, cb) {
		console.log("Adding Kibana Visualizations");
		let options = utils.buildDeployerOptions(env, soajs, model);
		options.params = {
			deployment: deployment
		};
		deployer.listServices(options, function (err, servicesList) {
			lib.configureKibana(soajs, servicesList, esClient, env, model, cb);
		});
	},
	
	/**
	 * do es bulk operations
	 * @param {object} esClient: cluster info
	 * @param {object} array: array of data
	 * @param {function} cb: callback function
	 */
	"esBulk": function (esClient, array, cb) {
		esClient.bulk(array, cb);
	},
	
	/**
	 * add metricbeat and filebeat visualizations
	 * @param {object} soajs: soajs object in req
	 * @param {object} esClient: cluster info
	 * @param {array} servicesList: list of all services
	 * @param {object} env: environment object
	 * @param {object} model: Mongo object
	 * @param {function} cb: callback function
	 */
	"configureKibana": function (soajs, servicesList, esClient, env, model, cb) {
		let analyticsArray = [];
		let serviceEnv = env.code.toLowerCase();
		async.parallel({
				"filebeat": function (pCallback) {
					async.each(servicesList, function (oneService, callback) {
						let serviceType;
						let serviceName, taskName;
						serviceEnv = serviceEnv.replace(/[\/*?"<>|,.-]/g, "_");
						if (oneService) {
							if (oneService.labels) {
								if (oneService.labels["soajs.service.repo.name"]) {
									serviceName = oneService.labels["soajs.service.repo.name"].replace(/[\/*?"<>|,.-]/g, "_");
								}
								if (oneService.labels["soajs.service.group"] === "soajs-core-services") {
									serviceType = (oneService.labels["soajs.service.repo.name"] === 'controller') ? 'controller' : 'service';
								}
								else if (oneService.labels["soajs.service.group"] === "nginx") {
									serviceType = 'nginx';
									serviceName = 'nginx';
								}
								else {
									return callback(null, true);
								}
								
								if (oneService.tasks.length > 0) {
									async.forEachOf(oneService.tasks, function (oneTask, key, call) {
										if (oneTask.status && oneTask.status.state && oneTask.status.state === "running") {
											taskName = oneTask.name;
											taskName = taskName.replace(/[\/*?"<>|,.-]/g, "_");
											if (key == 0) {
												//filebeat-service-environment-*
												
												analyticsArray = analyticsArray.concat(
													[
														{
															index: {
																_index: '.kibana',
																_type: 'index-pattern',
																_id: 'filebeat-' + serviceName + "-" + serviceEnv + "-" + "*"
															}
														},
														{
															title: 'filebeat-' + serviceName + "-" + serviceEnv + "-" + "*",
															timeFieldName: '@timestamp',
															fields: filebeatIndex.fields,
															fieldFormatMap: filebeatIndex.fieldFormatMap
														}
													]
												);
											}
											
											let options = {
													
													"$and": [
														{
															"_type": {
																"$in": ["dashboard", "visualization", "search"]
															}
														},
														{
															"_service": serviceType
														}
													]
												}
											;
											let combo = {
												conditions: options,
												collection: collection.analytics
											};
											model.findEntries(soajs, combo, function (error, records) {
												if (error) {
													return call(error);
												}
												records.forEach(function (oneRecord) {
													let serviceIndex;
													if (oneRecord._type === "visualization" || oneRecord._type === "search") {
														serviceIndex = serviceName + "-";
														if (oneRecord._injector === "service") {
															serviceIndex = serviceIndex + serviceEnv + "-" + "*";
														}
														else if (oneRecord._injector === "env") {
															serviceIndex = "*-" + serviceEnv + "-" + "*";
														}
														else if (oneRecord._injector === "taskname") {
															serviceIndex = serviceIndex + serviceEnv + "-" + taskName + "-" + "*";
														}
													}
													
													let injector;
													if (oneRecord._injector === 'service') {
														injector = serviceName + "-" + serviceEnv;
													}
													else if (oneRecord._injector === 'taskname') {
														injector = taskName;
													}
													else if (oneRecord._injector === 'env') {
														injector = serviceEnv;
													}
													oneRecord = JSON.stringify(oneRecord);
													oneRecord = oneRecord.replace(/%env%/g, serviceEnv);
													if (serviceIndex) {
														oneRecord = oneRecord.replace(/%serviceIndex%/g, serviceIndex);
													}
													if (injector) {
														oneRecord = oneRecord.replace(/%injector%/g, injector);
													}
													oneRecord = JSON.parse(oneRecord);
													let recordIndex = {
														index: {
															_index: '.kibana',
															_type: oneRecord._type,
															_id: oneRecord.id
														}
													};
													analyticsArray = analyticsArray.concat([recordIndex, oneRecord._source]);
												});
												return call(null, true);
											});
										}
										else {
											return call(null, true);
										}
									}, callback);
								}
								else {
									return callback(null, true);
								}
							}
							else {
								return callback(null, true);
							}
						}
						else {
							return callback(null, true);
						}
					}, pCallback);
				},
				"metricbeat": function (pCallback) {
					analyticsArray = analyticsArray.concat(
						[
							{
								index: {
									_index: '.kibana',
									_type: 'index-pattern',
									_id: 'metricbeat-*'
								}
							},
							{
								title: 'metricbeat-*',
								timeFieldName: '@timestamp',
								fields: metricbeatIndex.fields,
								fieldFormatMap: metricbeatIndex.fieldFormatMap
							}
						]
					);
					analyticsArray = analyticsArray.concat(
						[
							{
								index: {
									_index: '.kibana',
									_type: 'index-pattern',
									_id: 'filebeat-*-' + serviceEnv + "-*"
								}
							},
							{
								title: 'filebeat-*-' + serviceEnv + "-*",
								timeFieldName: '@timestamp',
								fields: filebeatIndex.fields,
								fieldFormatMap: filebeatIndex.fieldFormatMap
							}
						]
					);
					let combo = {
						"collection": collection.analytics,
						"conditions": {
							"_shipper": "metricbeat"
						}
					};
					model.findEntries(soajs, combo, function (error, records) {
						if (error) {
							return pCallback(error);
						}
						if (records && records.length > 0) {
							records.forEach(function (onRecord) {
								onRecord = JSON.stringify(onRecord);
								onRecord = onRecord.replace(/%env%/g, serviceEnv);
								onRecord = JSON.parse(onRecord);
								let recordIndex = {
									index: {
										_index: '.kibana',
										_type: onRecord._type,
										_id: onRecord.id
									}
								};
								analyticsArray = analyticsArray.concat([recordIndex, onRecord._source]);
							});
							
						}
						return pCallback(null, true);
					});
				}
			},
			function (err) {
				if (err) {
					return cb(err);
				}
				lib.esBulk(esClient, analyticsArray, cb);
			}
		);
	},
	
	/**
	 * deploy kibana service
	 * @param {object} soajs: soajs object in req
	 * @param {object} env: environment object
	 * @param {object} deployment: deployment object
	 * @param {object} model: Mongo object
	 * @param {function} cb: callback function
	 */
	"deployKibana": function (soajs, deployment, env, model, cb) {
		console.log("Checking Kibana");
		let combo = {};
		combo.collection = collection.analytics;
		combo.conditions = {
			"_type": "settings"
		};
		model.findEntry(soajs, combo, function (error, settings) {
			if (error) {
				return cb(error);
			}
			if (settings && settings.kibana && settings.kibana.status === "deployed") {
				console.log("Kibana found..");
				return cb(null, true);
			}
			else {
				console.log("Deploying Kibana..");
				lib.getAnalyticsContent("kibana", deployment, env, function (err, content) {
					if (err) {
						return cb(err);
					}
					let options = utils.buildDeployerOptions(env, soajs, model);
					options.params = content;
					async.parallel({
						"deploy": function (call) {
							deployer.deployService(options, call);
						},
						"update": function (call) {
							settings.kibana = {
								"status": "deployed"
							};
							combo.record = settings;
							model.saveEntry(soajs, combo, call);
						}
					}, cb);
				});
			}
			
		});
	},
	
	/**
	 * deploy logstash service
	 * @param {object} soajs: soajs object in req
	 * @param {object} deployment: deployment object
	 * @param {object} env: environment object
	 * @param {object} model: Mongo object
	 * @param {function} cb: callback function
	 */
	"deployLogstash": function (soajs, deployment, env, model, cb) {
		console.log("Checking Logstash..");
		let combo = {};
		combo.collection = collection.analytics;
		combo.conditions = {
			"_type": "settings"
		};
		model.findEntry(soajs, combo, function (error, settings) {
			if (error) {
				return cb(error);
			}
			if (settings && settings.logstash && settings.logstash[env.code.toLowerCase()] && settings.logstash[env.code.toLowerCase()].status === "deployed") {
				console.log("Logstash found..");
				return cb(null, true);
			}
			else {
				lib.getAnalyticsContent("logstash", deployment, env, function (err, content) {
					if (err) {
						return cb(err);
					}
					console.log("Deploying Logstash..");
					let options = utils.buildDeployerOptions(env, soajs, model);
					options.params = content;
					async.parallel({
						"deploy": function (call) {
							deployer.deployService(options, call);
						},
						"update": function (call) {
							if (!settings.logstash) {
								settings.logstash = {};
							}
							settings.logstash[env.code.toLowerCase()] = {
								"status": "deployed"
							};
							combo.record = settings;
							model.saveEntry(soajs, combo, call);
						}
					}, cb);
				});
			}
			
		});
	},
	
	/**
	 * deploy filebeat service
	 * @param {object} soajs: soajs object in req
	 * @param {object} deployment: deployment object
	 * @param {object} env: environment object
	 * @param {object} model: Mongo object
	 * @param {function} cb: callback function
	 */
	"deployFilebeat": function (soajs, deployment, env, model, cb) {
		console.log("Checking Filebeat..");
		let combo = {};
		combo.collection = collection.analytics;
		combo.conditions = {
			"_type": "settings"
		};
		model.findEntry(soajs, combo, function (error, settings) {
			if (error) {
				return cb(error);
			}
			if (settings && settings.filebeat && settings.filebeat[env.code.toLowerCase()] && settings.filebeat[env.code.toLowerCase()].status === "deployed") {
				console.log("Filebeat found..");
				return cb(null, true);
			}
			else {
				lib.getAnalyticsContent("filebeat", deployment, env, function (err, content) {
					if (err) {
						return cb(err);
					}
					console.log("Deploying Filebeat..");
					let options = utils.buildDeployerOptions(env, soajs, model);
					options.params = content;
					async.parallel({
						"deploy": function (call) {
							deployer.deployService(options, call);
						},
						"update": function (call) {
							if (!settings.filebeat) {
								settings.filebeat = {};
							}
							settings.filebeat[env.code.toLowerCase()] = {
								"status": "deployed"
							};
							combo.record = settings;
							model.saveEntry(soajs, combo, call);
						}
					}, cb);
				});
			}
			
		});
	},
	
	/**
	 * deploy metricbeat service
	 * @param {object} soajs: soajs object in req
	 * @param {object} deployment: deployment object
	 * @param {object} env: environment object
	 * @param {object} model: Mongo object
	 * @param {function} cb: callback function
	 */
	"deployMetricbeat": function (soajs, deployment, env, model, cb) {
		console.log("Checking Metricbeat..");
		let combo = {};
		combo.collection = collection.analytics;
		combo.conditions = {
			"_type": "settings"
		};
		model.findEntry(soajs, combo, function (error, settings) {
			if (error) {
				return cb(error);
			}
			if (settings && settings.metricbeat && settings.metricbeat && settings.metricbeat.status === "deployed") {
				console.log("Metricbeat found..");
				return cb(null, true);
			}
			else {
				lib.getAnalyticsContent("metricbeat", deployment, env, function (err, content) {
					if (err) {
						return cb(err);
					}
					console.log("Deploying Metricbeat..");
					let options = utils.buildDeployerOptions(env, soajs, model);
					options.params = content;
					async.parallel({
						"deploy": function (call) {
							deployer.deployService(options, call);
						},
						"update": function (call) {
							if (!settings.metricbeat) {
								settings.metricbeat = {};
							}
							settings.metricbeat = {
								"status": "deployed"
							};
							combo.record = settings;
							model.saveEntry(soajs, combo, call);
						}
					}, cb);
				});
			}
		});
	},
	
	/**
	 * check availablity of all services
	 * @param {object} soajs: soajs object in req
	 * @param {object} deployment: deployment object
	 * @param {object} env: environment object
	 * @param {object} model: Mongo object
	 * @param {function} cb: callback function
	 */
	"checkAvailability": function (soajs, deployment, env, model, cb) {
		console.log("Finalizing...");
		let options = utils.buildDeployerOptions(env, soajs, model);
		options.params = {
			deployment: deployment
		};
		let flk = ["kibana", "logstash", env.code.toLowerCase() + '-' + "filebeat", "soajs-metricbeat"];
		function check (cb){
			deployer.listServices(options, function (err, servicesList) {
				if (err) {
					return cb(err);
				}
				var failed = [];
				servicesList.forEach(function (oneService) {
					if (flk.indexOf(oneService.name) == !-1) {
						var status = false;
						oneService.tasks.forEach(function (oneTask) {
							if (oneTask.status.state === "running") {
								status = true;
							}
						});
						if (!status) {
							failed.push(oneService.name)
						}
					}
				});
				if (failed.length !== 0) {
					console.log(failed);
					setTimeout(function () {
						 check(cb);
					}, 1000);
				}
				else {
					return cb(null, true)
				}
			});
		}
		return check(cb);
	},
	
	/**
	 * add default index to kibana
	 * @param {object} soajs: soajs object in req
	 * @param {object} esClient: cluster info
	 * @param {object} env: environment object
	 * @param {object} model: Mongo object
	 * @param {function} cb: callback function
	 */
	"setDefaultIndex": function (soajs, deployment, esClient, env, model, cb) {
		let index = {
			index: ".kibana",
			type: 'config',
			body: {
				doc: {"defaultIndex": "metricbeat-*"}
			}
		};
		let condition = {
			index: ".kibana",
			type: 'config'
		};
		let combo = {
			collection: collection.analytics,
			conditions: {"_type": "settings"}
		};
		let options = {
			method: 'GET',
			url: 'http://127.0.0.1:32601/status'
		};
		if (deployment.external){
			options.url = 'http://' + process.env.CONTAINER_HOST + ':32601/status'
		}
		else {
			//todo in dashboard
		}
		//added check for availability of kibana
		request(options, function (error, response) {
			if (error || !response) {
				setTimeout(function () {
					lib.setDefaultIndex(soajs, deployment, esClient, env, model, cb);
				}, 3000);
			}
			else {
				esClient.db.search(condition, function (err, res) {
					if (err) {
						return cb(err);
					}
					if (res && res.hits && res.hits.hits && res.hits.hits.length > 0) {
						model.findEntry(soajs, combo, function (err, result) {
							if (err) {
								return cb(err);
							}
							index.id = res.hits.hits[0]._id;
							async.parallel({
								"updateES": function (call) {
									esClient.db.update(index, call);
								},
								"updateSettings": function (call) {
									let criteria = {
										"$set": {
											"kibana": {
												"version": index.id,
												"status": "deployed",
												"port": "32601"
											}
										}
									};
									result.env[env.code.toLowerCase()] = true;
									criteria["$set"].env = result.env;
									let options = {
										"safe": true,
										"multi": false,
										"upsert": false
									};
									combo.fields = criteria;
									combo.options = options;
									model.updateEntry(soajs, combo, call);
								}
							}, cb)
						});
					}
					else {
						setTimeout(function () {
							lib.setDefaultIndex(soajs, deployment, env, esClient, model, cb);
						}, 500);
					}
				});
			}
		});
	}
};

module.exports = lib;