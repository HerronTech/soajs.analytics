/* jshint esversion: 6 */
'use strict';
const uuid = require('uuid');
const async = require('async');
const fs = require('fs');
const deployer = require('soajs.core.drivers');

const config = require('../config.js');
const collections = {
  analytics: 'analytics',
  environment: 'environment',
  catalogs: 'catalogs',
  resources: "resources"
};
const filebeatIndex = require('../data/indexes/filebeat-index');
const metricbeatIndex = require('../data/indexes/metricbeat-index');

const utils = {
  /**
   * build deployer object
   * @param {object} soajs: req.soajs object
   * @param {object} envRecord: environment object
   * @param {object} model: mongo object
   */
  buildDeployerOptions(envRecord, envCode, model) {
    const options = {};
    let envDeployer = envRecord.deployer;
    
    if (!envDeployer) return null;
    if (Object.keys(envDeployer).length === 0) return null;
    if (!envDeployer.type || !envDeployer.selected) return null;
    if (envDeployer.type === 'manual') return null;
    
    const selected = envDeployer.selected.split('.');
    
    options.strategy = selected[1];
    options.driver = `${selected[1]}.${selected[2]}`;
    options.envRecord = envCode;
    
    for (let i = 0; i < selected.length; i++) {
      envDeployer = envDeployer[selected[i]];
    }
    options.deployerConfig = envDeployer;
    options.soajs = {registry: envRecord};
    options.model = model;
    
    // switch strategy name to follow drivers convention
    if (options.strategy === 'docker') options.strategy = 'swarm';
    
    return options;
  },
  
  /**
   * check if analytics is active in any other environment
   * @param {object} settings: analytics settings object
   * @param {object} currentEnv: current environment object
   */
  getActivatedEnv(settings, currentEnv) {
    let activated = false;
    if (settings && settings.env) {
      const environments = Object.keys(settings.env);
      environments.forEach((oneEnv) => {
        if (oneEnv !== currentEnv) {
          if (settings.env[oneEnv]) {
            activated = true;
          }
        }
      });
    }
    return activated;
  },
  
  "setEsCluster": (opts, cb) => {
    const soajs = opts.soajs;
    let settings = opts.analyticsSettings;
    const model = opts.model;
    const es_dbName = opts.es_dbName;
    let uid = uuid.v4();
    let es_env, es_analytics_db, es_analytics_cluster_name, es_analytics_cluster;
    let esExists = false;
    const soajsRegistry = soajs.registry;
    
    function getEsDb(cb) {
      utils.listEnvironments(soajs, model, (err, envs) => {
        if (err) {
          return cb(err);
        }
        if (envs && envs.length > 0) {
          for (let i = 0; i < envs.length; i++) {
            if (envs[i].dbs && envs[i].dbs.databases && envs[i].dbs.databases[es_analytics_db]) {
              es_analytics_cluster_name = envs[i].dbs.databases[es_analytics_db].cluster;
              es_env = envs[i];
              break;
            }
          }
        }
        return cb();
      });
    }
    
    async.series({
      "checkSettings": (mCb) => {
        if (settings && settings.elasticsearch
          && settings.elasticsearch.db_name && settings.elasticsearch.db_name !== '') {
          utils.printProgress(soajs, "found existing ES settings ...");
          es_analytics_db = settings.elasticsearch.db_name;
          //get cluster from environment using db name
          getEsDb(mCb);
          
        }
        else if (es_dbName) {
          utils.printProgress(soajs, "Elasticsearch db name was provided ...");
          es_analytics_db = es_dbName;
          getEsDb(mCb);
        }
        //if no db name provided create one
        else {
          utils.printProgress(soajs, "Generating new ES db and cluster information...");
          es_analytics_db = "es_analytics_db_" + uid;
          es_analytics_cluster_name = "es_analytics_cluster_" + uid;
          utils.createNewESDB(soajs, {
            dbName: es_analytics_db,
            clusterName: es_analytics_cluster_name
          }, model, mCb);
        }
      },
      "getClusterInfo": (mCb) => {
        let removeOptions;
        if (es_env) {
          //new style registry
          if (soajsRegistry.resources) {
            utils.printProgress(soajs, "checking resources ....");
            for (let resourceName in soajsRegistry.resources.cluster) {
              let tmpCluster = soajsRegistry.resources.cluster[resourceName];
              if (tmpCluster.locked && tmpCluster.shared && tmpCluster.category === 'elasticsearch'
                && tmpCluster.name === es_analytics_cluster_name) {
                es_analytics_cluster = tmpCluster.config;
              }
            }
          }
          else {
            utils.printProgress(soajs, "checking old style configuration....");
            es_analytics_cluster = es_env.dbs.clusters[es_analytics_cluster_name];
            removeOptions = {_id: es_env._id, name: es_analytics_cluster_name};
          }
          
          if (es_analytics_cluster) {
            esExists = true;
          }
        }
        else {
          utils.printProgress(soajs, "no cluster found, generating new configuration...");
          es_analytics_cluster = config.elasticsearch.cluster;
          if (opts.credentials && opts.credentials.username && opts.credentials.password) {
            es_analytics_cluster.credentials = opts.credentials;
          }
          if (soajsRegistry.deployer.selected.split('.')[1] === "kubernetes") {
            //added support for namespace and perService
            let namespace = soajsRegistry.deployer.container["kubernetes"][soajsRegistry.deployer.selected.split('.')[2]].namespace.default;
            if (soajsRegistry.deployer.container["kubernetes"][soajsRegistry.deployer.selected.split('.')[2]].namespace.perService) {
              namespace += '-soajs-analytics-elasticsearch-service';
            }
            es_analytics_cluster.servers[0].host += '-service.' + namespace;
          }
        }
        if (removeOptions && Object.keys(es_analytics_cluster).length > 0) {
          async.series({
            "removeOld": (eCb) => {
              utils.removeESClustersFromEnvRecord(soajs, removeOptions, model, eCb);
            },
            "pushNew": (eCb) => {
              utils.saveESClustersInResources(soajs, {
                name: es_analytics_cluster_name,
                config: es_analytics_cluster
              }, model, eCb);
            }
          }, mCb);
        }
        else if (esExists) {
          return mCb();
        }
        else {
          utils.saveESClustersInResources(soajs, {
            name: es_analytics_cluster_name,
            config: es_analytics_cluster
          }, model, mCb);
        }
      },
      "buildAnalyticsConfiguration": (mCb) => {
        if (!es_analytics_db || !es_analytics_cluster_name || !es_analytics_cluster) {
          async.parallel([
            (miniCb) => {
              settings.elasticsearch = {};
              model.saveEntry(soajs, {
                collection: collections.analytics,
                record: settings
              }, miniCb);
            },
            (miniCb) => {
              if (!es_env) {
                return miniCb();
              }
              
              if (es_analytics_db) {
                delete es_env.dbs.databases[es_analytics_db];
              }
              
              model.updateEntry(soajs, {
                collection: collections.environment,
                conditions: {_id: es_env._id},
                fields: {
                  $set: {
                    dbs: es_env.dbs
                  }
                }
              }, miniCb);
            }
          ], (error) => {
            if (error) {
              utils.printProgress(soajs, error, "error");
            }
            return mCb(null, null);
          });
        }
        else {
          let opts = {};
          opts.collection = collections.analytics;
          if (!settings || settings === {}) {
            settings = {};
            settings._type = "settings";
            settings.env = {};
            settings.env[soajs.inputmaskData.env.toLowerCase()] = false;
            settings.elasticsearch = {
              "db_name": es_analytics_db
            }
          }
          if (settings.elasticsearch) {
            settings.elasticsearch.db_name = es_analytics_db;
          }
          opts.record = settings;
          model.saveEntry(soajs, opts, mCb);
        }
        
      }
    }, (error) => {
      if (!process.env.SOAJS_INSTALL_DEBUG) {
        es_analytics_cluster.extraParam.log = [{
          type: 'stdio',
          levels: [] // remove the logs
        }];
      }
      opts.esDbInfo = {
        esDbName: es_analytics_db,
        esClusterName: es_analytics_cluster_name,
        esCluster: es_analytics_cluster
      };
      return cb(error, true);
    });
  },
  
  /**
   * Create a new es db entry in environment databases
   * @param soajs
   * @param options
   * @param model
   * @param cb
   */
  "createNewESDB": (soajs, options, model, cb) => {
    let opts = {};
    opts.collection = collections.environment;
    opts.conditions = {
      code: soajs.inputmaskData.env.toUpperCase()
    };
    
    let newDB = {};
    newDB["dbs.databases." + options.dbName] = {
      "cluster": options.clusterName,
      "tenantSpecific": false
    };
    
    opts.fields = {
      "$set": newDB
    };
    opts.options = {
      safe: true,
      upsert: false,
      mutli: false
    };
    
    model.updateEntry(soajs, opts, cb);
  },
  
  /**
   * Save ES Cluster Resource
   * @param {Object} soajs
   * @param {Object} options
   * @param {Object} model
   * @param {Function} cb
   */
  "saveESClustersInResources": (soajs, options, model, cb) => {
    let opts = {};
    opts.collection = collections.resources;
    opts.conditions = {
      "type": "cluster",
      "shared": true,
      "locked": true,
      "plugged": true,
      "created": process.env.SOAJS_ENV.toUpperCase(),
      "category": "elasticsearch",
      "name": options.name
    };
    opts.fields = {
      $set: {
        "author": "analytics",
        "config": options.config
      }
    };
    opts.options = {
      'upsert': true,
      'multi': false,
      'safe': true
    };
    model.updateEntry(soajs, opts, cb);
  },
  
  /**
   * Remove ES Cluster from Env Record
   * @param {Object} soajs
   * @param {Object} options
   * @param {Object} model
   * @param {Function} cb
   */
  "removeESClustersFromEnvRecord": (soajs, options, model, cb) => {
    let opts = {};
    opts.collection = collections.environment;
    opts.conditions = {
      _id: options._id
    };
    
    let unset = {};
    unset["dbs.clusters." + options.name] = {};
    
    opts.fields = {
      "$unset": unset
    };
    model.updateEntry(soajs, opts, cb);
  },
  
  /**
   * List Environments
   * @param soajs
   * @param model
   * @param cb
   */
  "listEnvironments": (soajs, model, cb) => {
    let opts = {};
    opts.collection = collections.environment;
    opts.fields = {"dbs": 1};
    model.findEntries(soajs, opts, cb);
  },
  
  /**
   * prints a message with a time prefix or uses soajs log feature
   * @param {object} args: object
   */
  printProgress(...args) {
    let soajs = args[0], message = args[1], type = args[2];
    if (soajs.log) {
      if (type === 'error' && soajs.log.error){
        soajs.log.error(message);
      }
      if (soajs.log.debug) {
        soajs.log.debug(message);
      }
    }
    else {
      if (type === 'error'){
        console.log(message);
      }
      else {
        console.log(showTimestamp() + ' - ' + message);
      }
    }
    
    function showTimestamp() {
      var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      var now = new Date();
      return '' + now.getDate() + ' ' + months[now.getMonth()] + ' ' + now.getHours() + ':' +
        ((now.getMinutes().toString().length === 2) ? now.getMinutes() : '0' + now.getMinutes()) + ':' +
        ((now.getSeconds().toString().length === 2) ? now.getSeconds() : '0' + now.getSeconds());
    }
  },
  
  /**
   * check if soajs elasticsearch is deployed
   * @param {object} soajs: req.soajs object
   * @param {object} deployment: installer deployment object
   * @param {object} env: environment object
   * @param {object} model: mongo object
   * @param {function} cb: callback function
   */
  checkElasticsearch(opts, cb) {
    const soajs = opts.soajs;
    const deployment = opts.deployment;
    const env = opts.soajs.registry;
    const model = opts.model;
    const es_dbName = opts.es_dbName;
    utils.printProgress(soajs, 'Checking Elasticsearch');
    if (!es_dbName) {
      const options = utils.buildDeployerOptions(env, opts.envCode, model);
      options.params = {
        deployment,
      };
      let flk = 'soajs-analytics-elasticsearch';
      if (env.deployer.selected.split('.')[1] === 'kubernetes') {
        // added support for namespace and perService
        let namespace = env.deployer.container.kubernetes[env.deployer.selected.split('.')[2]].namespace.default;
        if (env.deployer.container.kubernetes[env.deployer.selected.split('.')[2]].namespace.perService) {
          namespace += '-soajs-analytics-elasticsearch-service';
        }
        //check this
        flk += `-service.${namespace}`;
      }
      return check(options, flk, cb);
    }
    else {
      return cb(null, true);
    }
    function check(options, flk, cb) {
      deployer.listServices(options, (err, servicesList) => {
        if (err) {
          return cb(err);
        }
        let found = false;
        servicesList.forEach((oneService) => {
          if (flk === oneService.name) {
            found = true;
          }
        });
        return cb(null, found);
      });
    }
  },
  
  /**
   * Check if Elastic Search is up and running
   * @param context
   * @param cb
   */
  pingElastic(context, cb) {
    let soajs = context.soajs;
    let env = context.soajs.registry;
    let envCode = context.envCode;
    let esDbInfo = context.esDbInfo;
    let model = context.model;
    let tracker = context.tracker;
    let esClient = context.esClient;
    let settings = context.analyticsSettings;
    esClient.ping((error) => {
      if (error) {
        // soajs.log.error(error);
        tracker[envCode].counterPing++;
        utils.printProgress(soajs, `Waiting for ES Cluster to reply, attempt: ${tracker[envCode].counterPing} / 10`);
        if (tracker[envCode].counterPing >= 10) { // wait 5 min
          utils.printProgress(soajs, "Elasticsearch wasn't deployed... exiting", "error");
          
          async.parallel([
            function (miniCb) {
              settings.elasticsearch = {};
              
              model.saveEntry(soajs, {
                collection: collections.analytics,
                record: settings
              }, miniCb);
            },
            function (miniCb) {
              //env is not the requested environment, it's the registry
              //clean up all environments of this db entry and its cluster
              model.findEntries(soajs, {collection: collections.environment}, (error, environmentRecords) => {
                if (error) {
                  return miniCb(error);
                }
                
                async.each(environmentRecords, (oneEnv, vCb) => {
                  delete oneEnv.dbs.databases[esDbInfo.db];
                  
                  if (oneEnv.dbs.clusters) {
                    delete oneEnv.dbs.clusters[esDbInfo.cluster];
                  }
                  model.saveEntry(soajs, {
                    collection: collections.environment,
                    record: oneEnv
                  }, vCb);
                }, (error) => {
                  if (error) {
                    return miniCb(error);
                  }
                  
                  if (env.resources) {
                    utils.removeESClustersFromEnvRecord(soajs, esDbInfo.cluster, model, miniCb);
                  }
                  else {
                    return miniCb();
                  }
                });
              });
            }
          ], (err) => {
            if (err) {
              utils.printProgress(soajs, err, "error");
            }
            return cb(error);
          });
        }
        else {
          setTimeout(() => {
            utils.pingElastic(context, cb);
          }, 2000);
        }
      }
      else {
        utils.infoElastic(context, cb)
      }
    });
  },
  
  /**
   * Function that removes and ES cluster from resources collection.
   * @param soajs
   * @param name
   * @param model
   * @param cb
   */
  removeESClusterFromResources: function (soajs, name, model, cb) {
    model.removeEntry(soajs, {
      collection: collections.resources,
      conditions: {
        locked: true,
        shared: true,
        category: "elasticsearch",
        "name": name
      }
    }, cb);
  },
  
  /**
   * check if elastic search was deployed correctly and if ready to receive data
   * @param context
   * @param cb
   */
  "infoElastic": function (context, cb) {
    let soajs = context.soajs;
    let env = context.soajs.registry;
    let envCode = context.envCode;
    let esDbInfo = context.esDbInfo;
    let esClient = context.esClient;
    let model = context.model;
    let tracker = context.tracker;
    let settings = context.analyticsSettings;
    
    esClient.db.info((error) => {
      if (error) {
        // soajs.log.error(error);
        tracker[envCode].counterInfo++;
        utils.printProgress(soajs, `ES cluster found but not ready, Trying again: ${tracker[envCode].counterInfo} / 15`);
        if (tracker[envCode].counterInfo >= 15) { // wait 5 min
          utils.printProgress(soajs, "Elasticsearch wasn't deployed correctly ... exiting");
          
          async.parallel([
            function (miniCb) {
              settings.elasticsearch = {};
              
              model.saveEntry(soajs, {
                collection: collections.analytics,
                record: settings
              }, miniCb);
            },
            function (miniCb) {
              //env is not the requested environment, it's the registry
              //clean up all environments of this db entry and its cluster
              model.findEntries(soajs, {collection: collections.environment}, (error, environmentRecords) => {
                if (error) {
                  return miniCb(error);
                }
                
                async.each(environmentRecords, (oneEnv, vCb) => {
                  delete oneEnv.dbs.databases[esDbInfo.esDbName];
                  
                  if (oneEnv.dbs.clusters) {
                    delete oneEnv.dbs.clusters[esDbInfo.esClusterName];
                  }
                  model.saveEntry(soajs, {
                    collection: collections.environment,
                    record: oneEnv
                  }, vCb);
                }, (error) => {
                  if (error) {
                    return miniCb(error);
                  }
                  
                  if (env.resources) {
                    utils.removeESClusterFromResources(soajs, esDbInfo.esClusterName, model, miniCb);
                  }
                  else {
                    return miniCb();
                  }
                });
              });
            }
          ], (err) => {
            if (err) {
              utils.printProgress(soajs, err, "error");
            }
            return cb(error);
          });
        }
        else {
          setTimeout(() => {
            utils.infoElastic(context, cb);
          }, 3000);
        }
      }
      else {
        return cb(null, true);
      }
    });
  },
  
  /**
   * purge all previous indexes for filebeat and metricbeat
   * @param context
   * @param cb
   */
  "purgeElastic": function (context, cb) {
    let soajs = context.soajs;
    let esClient = context.esClient;
    
    if (!context.purge) {
      //purge not reguired
      return cb(null, true);
    }
    utils.printProgress(soajs, "Purging data...");
    esClient.db.indices.delete({index: 'filebeat-*'}, (filebeatError) => {
      if (filebeatError) {
        return cb(filebeatError);
      }
      esClient.db.indices.delete({index: 'metricbeat-*'}, (metricbeatError) => {
        return cb(metricbeatError, true);
      });
    });
  },
  
  /**
   * Create templates for all the ES indexes
   * @param context
   * @param cb
   */
  "putTemplate": function (context, cb) {
    let soajs = context.soajs;
    let esClient = context.esClient;
    let model = context.model;
    
    let combo = {
      collection: collections.analytics,
      conditions: {_type: 'template'}
    };
    model.findEntries(soajs, combo, (error, templates) => {
      if (error) return cb(error);
      async.each(templates, (oneTemplate, callback) => {
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
        
        esClient.db.indices.putTemplate(options, (error) => {
          return callback(error, true);
        });
      }, cb);
    });
  },
  
  /**
   * Create new indexes with their mapping
   * @param context
   * @param cb
   */
  "putMapping": function (context, cb) {
    let soajs = context.soajs;
    let esClient = context.esClient;
    let model = context.model;
    
    //todo change this
    let combo = {
      collection: collections.analytics,
      conditions: {_type: 'mapping'}
    };
    model.findEntries(soajs, combo, (error, mappings) => {
      if (error) return cb(error);
      let mapping = {
        index: '.soajs-kibana',
        body: mappings._json
      };
      
      esClient.db.indices.exists({index: '.soajs-kibana'}, (error, result) => {
        if (error || !result) {
          esClient.db.indices.create(mapping, (err) => {
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
   * Configure Kibana and its visualizations
   * @param context
   * @param servicesList
   * @param cb
   */
  "configureKibana": function (context, servicesList, cb) {
    let soajs = context.soajs;
    let esClient = context.esClient;
    let model = context.model;
    let analyticsArray = [];
    let serviceEnv = context.envCode;
    async.parallel({
        filebeat(pCallback) {
          async.each(servicesList, (oneService, callback) => {
            let serviceType;
            let serviceName,
              taskName;
            serviceEnv = serviceEnv.replace(/[\/*?"<>|,.-]/g, '_');
            if (oneService) {
              if (oneService.labels) {
                if (oneService.labels["soajs.service.repo.name"]) {
                  serviceName = oneService.labels["soajs.service.repo.name"].replace(/[\/*?"<>|,.-]/g, "_");
                }
                if (oneService.labels["soajs.service.group"] === "soajs-core-services") {
                  serviceType = (oneService.labels["soajs.service.repo.name"] === 'controller') ? 'controller' : 'service';
                }
                else if (oneService.labels["soajs.service.group"] === "soajs-nginx") {
                  serviceType = 'nginx';
                  serviceName = 'nginx';
                }
                else {
                  return callback(null, true);
                }
                
                if (oneService.tasks.length > 0) {
                  async.forEachOf(oneService.tasks, (oneTask, key, call) => {
                    if (oneTask.status && oneTask.status.state && oneTask.status.state === "running") {
                      taskName = oneTask.name;
                      taskName = taskName.replace(/[\/*?"<>|,.-]/g, "_");
                      if (key === 0) {
                        //filebeat-service-environment-*
                        analyticsArray = analyticsArray.concat(
                          [
                            {
                              index: {
                                _index: '.soajs-kibana',
                                _type: 'index-pattern',
                                _id: `filebeat-${serviceName}-${serviceEnv}-` + '*',
                              },
                            },
                            {
                              title: `filebeat-${serviceName}-${serviceEnv}-` + '*',
                              timeFieldName: '@timestamp',
                              fields: filebeatIndex.fields,
                              fieldFormatMap: filebeatIndex.fieldFormatMap
                            },
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
                      };
                      let combo = {
                        conditions: options,
                        collection: collections.analytics,
                      };
                      model.findEntries(soajs, combo, (error, records) => {
                        if (error) {
                          return call(error);
                        }
                        records.forEach((oneRecord) => {
                          let serviceIndex;
                          if (oneRecord._type === 'visualization' || oneRecord._type === 'search') {
                            serviceIndex = `${serviceName}-`;
                            if (oneRecord._injector === 'service') {
                              serviceIndex = `${serviceIndex + serviceEnv}-` + '*';
                            } else if (oneRecord._injector === 'env') {
                              serviceIndex = `*-${serviceEnv}-` + '*';
                            } else if (oneRecord._injector === 'taskname') {
                              serviceIndex = `${serviceIndex + serviceEnv}-${taskName}-` + '*';
                            }
                          }
                          let injector;
                          if (oneRecord._injector === 'service') {
                            injector = `${serviceName}-${serviceEnv}`;
                          } else if (oneRecord._injector === 'taskname') {
                            injector = taskName;
                          } else if (oneRecord._injector === 'env') {
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
                          const recordIndex = {
                            index: {
                              _index: '.soajs-kibana',
                              _type: oneRecord._type,
                              _id: oneRecord.id
                            }
                          };
                          analyticsArray = analyticsArray.concat([recordIndex, oneRecord._source]);
                        });
                        return call(null, true);
                      });
                    } else {
                      return call(null, true);
                    }
                  }, callback);
                } else {
                  return callback(null, true);
                }
              } else {
                return callback(null, true);
              }
            } else {
              return callback(null, true);
            }
          }, pCallback);
        },
        metricbeat(pCallback) {
          analyticsArray = analyticsArray.concat(
            [
              {
                index: {
                  _index: '.soajs-kibana',
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
                  _index: '.soajs-kibana',
                  _type: 'index-pattern',
                  _id: `filebeat-*-${serviceEnv}-*`,
                },
              },
              {
                title: `filebeat-*-${serviceEnv}-*`,
                timeFieldName: '@timestamp',
                fields: filebeatIndex.fields,
                fieldFormatMap: filebeatIndex.fieldFormatMap
              }
            ]
          );
          const combo = {
            collection: collections.analytics,
            "conditions": {
              "_shipper": "metricbeat"
            }
          };
          model.findEntries(soajs, combo, (error, records) => {
            if (error) {
              return pCallback(error);
            }
            if (records && records.length > 0) {
              records.forEach((onRecord) => {
                onRecord = JSON.stringify(onRecord);
                onRecord = onRecord.replace(/%env%/g, serviceEnv);
                onRecord = JSON.parse(onRecord);
                const recordIndex = {
                  index: {
                    _index: '.soajs-kibana',
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
      (err) => {
        if (err) {
          return cb(err);
        }
        // if (analyticsArray.length !== 0 && !(process.env.SOAJS_TEST_ANALYTICS === 'test')) {
        if (analyticsArray.length !== 0) {
          utils.esBulk(esClient, analyticsArray, (error, response) => {
            if (error) {
              utils.printProgress(soajs, error, "error");
            }
            return cb(error, response);
          });
        }
        else {
          return cb(null, true);
        }
      }
    );
  },
  
  /**
   * Function that run ElasticSearch Bulk operations
   * @param esClient
   * @param array
   * @param cb
   */
  "esBulk": function (esClient, array, cb) {
    esClient.bulk(array, cb);
  },

  /**
   * create deployment object
   * @param {object} opts: installer deployment object
   * @param {string} service: elk file name
   * @param {function} cb: callback function
   */
  getAnalyticsContent(opts, service, cb) {
    const soajs = opts.soajs;
    const config = opts.config;
    const model = opts.model;
    const catalogDeployment = opts.catalogDeployment;
    const deployment = opts.deployment;
    const env = opts.soajs.registry
    const envCode = opts.envCode;
    const esCluster = opts.esDbInfo.esCluster;
    const elasticAddress = opts.elasticAddress;
    if (service === 'elastic' || service === 'filebeat' || (deployment && deployment.external)) {
      const path = `${__dirname}/../data/services/elk/`;
      fs.exists(path, (exists) => {
        if (!exists) {
          return cb(`Folder [${path}] does not exist`);
        }
        let loadContent;
        try {
          loadContent = require(path + service);
        } catch (e) {
          return cb(e);
        }
        let serviceParams = {
          env: loadContent.env,
          name: loadContent.name,
          image: loadContent.deployConfig.image,
          imagePullPolicy: 'IfNotPresent', // need to be removed
          variables: loadContent.variables || [],
          labels: loadContent.labels,
          //memoryLimit: loadContent.deployConfig.memoryLimit,
          replication: {
            mode: loadContent.deployConfig.replication.mode,
            replicas: loadContent.deployConfig.replication.replicas,
          },
          containerDir: loadContent.deployConfig.workDir,
          restartPolicy: {
            condition: loadContent.deployConfig.restartPolicy.condition,
            maxAttempts: loadContent.deployConfig.restartPolicy.maxAttempts,
          },
          network: loadContent.deployConfig.network,
          ports: loadContent.deployConfig.ports || [],
        };
        
        if (loadContent.command && loadContent.command.cmd) {
          serviceParams.command = loadContent.command.cmd;
        }
        if (loadContent.command && loadContent.command.args) {
          serviceParams.args = loadContent.command.args;
        }
        // if deployment is kubernetes
        let logNameSpace = '';
        if (env.deployer.selected.split('.')[1] === 'kubernetes') {
          // "soajs.service.mode": "deployment"
          if (serviceParams.replication.mode === "replicated") {
            serviceParams.replication.mode = "deployment";
            serviceParams.labels["soajs.service.mode"] = "deployment";
          }
          else if (serviceParams.replication.mode === "global") {
            serviceParams.replication.mode = "daemonset";
            serviceParams.labels["soajs.service.mode"] = "daemonset";
          }
          logNameSpace = `-service.${env.deployer.container.kubernetes[env.deployer.selected.split('.')[2]].namespace.default}`;
          
          if (env.deployer.container.kubernetes[env.deployer.selected.split('.')[2]].namespace.perService) {
            logNameSpace += `-${envCode}-logstash-service`;
          }
          // change published port name
         
          if (service === 'kibana') {
            serviceParams.ports[0].published = 32601;
          }
        }
        if (loadContent.deployConfig.volume) {
          if (env.deployer.selected.split('.')[1] === 'kubernetes') {
            serviceParams.voluming = {
              volumes: [],
              volumeMounts: [],
            };
            loadContent.deployConfig.volume.forEach((oneVolume) => {
              serviceParams.voluming.volumes.push({
                name: oneVolume.Source,
                hostPath: {
                  path: oneVolume.Target,
                },
              });
              serviceParams.voluming.volumeMounts.push({
                name: oneVolume.Source,
                mountPath: oneVolume.Target,
              });
            });
          } else if (env.deployer.selected.split('.')[1] === 'docker') {
            if (service === 'metricbeat') {
              loadContent.deployConfig.volume[0].Source = loadContent.deployConfig.volume[0].Target;
            }
            serviceParams.voluming = {
              volumes: loadContent.deployConfig.volume,
            };
          }
        }
        if (loadContent.deployConfig.annotations) {
          serviceParams.annotations = loadContent.deployConfig.annotations;
        }
        // add support for multiple elasticsearch hosts;
        if (service === 'logstash' || service === 'metricbeat') {
          serviceParams.variables.push(
            `${'SOAJS_ANALYTICS_ES_NB' + '='}${esCluster.servers.length}`
          );
          let counter = 1;
          esCluster.servers.forEach((server) => {
            serviceParams.variables.push(`SOAJS_ANALYTICS_ES_IP_${counter}=${server.host}`);
            serviceParams.variables.push(`SOAJS_ANALYTICS_ES_PORT_${counter}=${server.port}`);
            counter++;
          });
        }
        serviceParams = JSON.stringify(serviceParams);
        // add namespace
        if (service === 'kibana') {
          serviceParams = serviceParams.replace(/%elasticsearch_url%/g, `${esCluster.URLParam.protocol}://${elasticAddress}`);
        }
        if (service === 'filebeat') {
          serviceParams = serviceParams.replace(/%logNameSpace%/g, logNameSpace);
        }
        // if (service === "logstash" || service === "metricbeat") {
        // 	serviceParams = serviceParams.replace(/%elasticsearch_url%/g, auto.getElasticClientNode);
        // }
        if(serviceParams.indexOf("%env%") !== -1){
          serviceParams = serviceParams.replace(/%env%/g, envCode);
          serviceParams = JSON.parse(serviceParams);
          serviceParams.labels['soajs.env.code'] = envCode;
        }
        else{
          serviceParams = JSON.parse(serviceParams);
          serviceParams.labels['soajs.env.code'] = envCode;
        }
        serviceParams = serviceParams.replace(/%env%/g, envCode);
        serviceParams = JSON.parse(serviceParams);
        serviceParams.deployment = deployment;
        return cb(null, serviceParams);
      });
    } else {
      // incase of kibana add the url
      // call mongo and get the recipe id
      if (service === 'metricbeat' || service === 'logstash' || service === 'kibana') {
        fillCatalogOpts(soajs, model, (err) => {
          if (err) {
            return cb(err);
          }
          catalogDeployment.deployService(config, soajs, soajs.registry, {}, cb);
        });
      } else {
        return cb('invalid service name');
      }
    }
    //do i need an else??
    
    
    function fillCatalogOpts(soajs, model, call) {
      const combo = {};
      combo.collection = collections.catalogs;
      combo.conditions = {
        type: 'system',
        
      };
      /**
       * name : name of the service (resolved to env-name, or name if allEnv is set to true)
       * env : environent variables
       * allEnv : if set true, service is not per env
       */
      switch (service) {
        case 'logstash':
          combo.conditions.name = 'Logstash Recipe';
          combo.conditions.subtype = 'logstash';
          soajs.inputmaskData.custom = {
            name: `${env.environment.toLowerCase()}-logstash`
          };
          soajs.inputmaskData.deployConfig = {
            replication: {
              mode: 'replicated',
            },
          };
          break;
        case 'kibana':
          combo.conditions.name = 'Kibana Recipe';
          combo.conditions.subtype = 'kibana';
          soajs.inputmaskData.custom = {
            name: 'soajs-kibana',
           // allEnv: true,
            env: {
              ELASTICSEARCH_URL: `${esCluster.URLParam.protocol}://${elasticAddress}`,
            },
          };
          soajs.inputmaskData.deployConfig = {
            replication: {
              mode: 'replicated',
            },
          };
          break;
        case 'metricbeat':
          soajs.inputmaskData.custom = {
            name: 'soajs-metricbeat',
            //allEnv: true,
          };
          soajs.inputmaskData.deployConfig = {
            replication: {
              mode: 'global',
            },
          };
          combo.conditions.name = 'Metricbeat Recipe';
          combo.conditions.subtype = 'metricbeat';
          
          break;
      }
      if (env.deployer.selected.split('.')[1] === 'kubernetes') {
        if (soajs.inputmaskData.deployConfig.replication.mode === 'replicated') {
          soajs.inputmaskData.deployConfig.replication.mode = 'deployment';
        }
        else if (soajs.inputmaskData.deployConfig.replication.mode === 'global') {
          soajs.inputmaskData.deployConfig.replication.mode = 'daemonset';
        }
      }
      model.findEntry(soajs, combo, (err, recipe) => {
        if (err) {
          return call(err);
        }
        if (!recipe) {
          return call(`No Recipe found for ${service}`);
        }
        soajs.inputmaskData.action = 'analytics';
        soajs.inputmaskData.env = env.environment.toLowerCase();
        soajs.inputmaskData.recipe = recipe._id.toString();
        return call(null, true);
      });
    }
  },
  
};

module.exports = utils;
