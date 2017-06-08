/* jshint esversion: 6 */
'use strict';
const uuid = require('uuid');
const async = require('async');
const fs = require('fs');
const deployer = require('soajs.core.drivers');

const es = require('./es');
const config = require('../config.js');
const collections = {
  analytics: 'analytics',
  environment: 'environment',
  catalogs: 'catalogs'
};
const filebeatIndex = require('../data/indexes/filebeat-index');
const metricbeatIndex = require('../data/indexes/metricbeat-index');
let counter = 0;

const utils = {
  /**
   * build deployer object
   * @param {object} soajs: req.soajs object
   * @param {object} envRecord: environment object
   * @param {object} model: mongo object
   */
  buildDeployerOptions(envRecord, soajs, model) {
    const options = {};
    let envDeployer = envRecord.deployer;
    
    if (!envDeployer) return null;
    if (Object.keys(envDeployer).length === 0) return null;
    if (!envDeployer.type || !envDeployer.selected) return null;
    if (envDeployer.type === 'manual') return null;
    
    const selected = envDeployer.selected.split('.');
    
    options.strategy = selected[1];
    options.driver = `${selected[1]}.${selected[2]}`;
    options.env = envRecord.code.toLowerCase();
    
    for (let i = 0; i < selected.length; i++) {
      envDeployer = envDeployer[selected[i]];
    }
    
    options.deployerConfig = envDeployer;
    options.soajs = {registry: soajs.registry};
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
  
  /**
   * check if soajs elasticsearch is deployed
   * @param {object} soajs: req.soajs object
   * @param {object} model: mongo object
   * @param {object} dashboard: dashboard environment object
   * @param {object} envRecord: current environment object
   * @param {object} settings: analytics settings object
   * @param {function} cb: callback function
   */
  addEsClusterToDashboard(soajs, model, dashboard, envRecord, settings, cb) {
    const uid = uuid.v4();
    const es_analytics_db_name = `es_analytics_db_${uid}`;
    const es_analytics_cluster_name = `es_analytics_cluster_${uid}`;
    const es_analytics_cluster = config.elasticsearch.cluster;
    
    if (envRecord.deployer.selected.split('.')[1] === 'kubernetes') {
      // added support for namespace and perService
      let namespace = envRecord.deployer.container.kubernetes[envRecord.deployer.selected.split('.')[2]].namespace.default;
      if (envRecord.deployer.container.kubernetes[envRecord.deployer.selected.split('.')[2]].namespace.perService) {
        namespace += '-soajs-analytics-elasticsearch-service';
      }
      es_analytics_cluster.servers[0].host += `-service.${namespace}`;
    }
    dashboard.dbs.databases[es_analytics_db_name] = {
      cluster: es_analytics_cluster_name,
      tenantSpecific: false,
      usedForAnalytics: true,
    };
    dashboard.dbs.clusters[es_analytics_cluster_name] = es_analytics_cluster;
    
    async.parallel({
      updateDashboard(call) {
        const comboD = {};
        comboD.collection = collections.environment;
        comboD.record = envRecord;
        model.saveEntry(soajs, comboD, call);
      },
      updateSettings(call) {
        const comboS = {};
        comboS.collection = collections.analytics;
        if (!settings) {
          settings = {};
          settings._type = 'settings';
          settings.env = {};
          settings.env[envRecord.code.toLowerCase()] = false;
          settings.elasticsearch = {
            db_name: es_analytics_db_name,
          };
          comboS.record = settings;
          model.insertEntry(soajs, comboS, call);
        } else {
          settings.elasticsearch.db_name = es_analytics_db_name;
          comboS.record = settings;
          model.saveEntry(soajs, comboS, call);
        }
      },
    }, function (err) {
      if (err) {
        return cb(err);
      }
      return cb(null, es_analytics_cluster);
    });
  },
  
  /**
   * prints a message with a time prefix
   * @param {object} soajs: req.soajs object
   * @param {object} message: message to be printed
   */
  printProgress(soajs, message) {
    if (soajs.log && soajs.log.debug) {
      soajs.log.debug(message);
    }
    else {
      console.log(showTimestamp() + ' - ' + message);
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
  checkElasticsearch(soajs, deployment, env, model, cb) {
    utils.printProgress(soajs, 'Checking Elasticsearch');
    const options = utils.buildDeployerOptions(env, soajs, model);
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
      flk += `.-service${namespace}`;
    }
    function check(cb) {
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
        return found ? cb(null, true) : cb(null, false);
      });
    }
    
    return check(cb);
  },
  
  /**
   * ping elasticsearch
   * @param {object} esClient: elasticsearch connector object
   * @param {function} cb: callback function
   */
  pingElastic(esClient, cb) {
    esClient.ping((error) => {
      if (error) {
        setTimeout(() => {
          if (counter > 150) { // wait 5 min
            cb(error);
          }
          counter++;
          utils.pingElastic(esClient, cb);
        }, 2000);
      } else {
        utils.infoElastic(esClient, cb);
      }
    });
  },
  
  /**
   * check if elasticsearch is ready
   * @param {object} esClient: elasticsearch connector object
   * @param {function} cb: callback function
   */
  infoElastic(esClient, cb) {
    esClient.db.info((error) => {
      if (error) {
        setTimeout(() => {
          utils.infoElastic(esClient, cb);
        }, 3000);
      } else {
        counter = 0;
        return cb(null, true);
      }
    });
  },
  
  /**
   * add templates to es
   * @param {object} soajs: soajs object in req
   * @param {object} model: Mongo object
   * @param {object} esClient: cluster info
   * @param {function} cb: callback function
   */
  putTemplate(soajs, model, esClient, cb) {
    const combo = {
      collection: collections.analytics,
      conditions: {_type: 'template'},
    };
    model.findEntries(soajs, combo, (error, templates) => {
      if (error) return cb(error);
      async.each(templates, (oneTemplate, callback) => {
        if (oneTemplate._json.dynamic_templates && oneTemplate._json.dynamic_templates['system-process-cgroup-cpuacct-percpu']) {
          oneTemplate._json.dynamic_templates['system.process.cgroup.cpuacct.percpu'] = oneTemplate._json.dynamic_templates['system-process-cgroup-cpuacct-percpu'];
          delete oneTemplate._json.dynamic_templates['system-process-cgroup-cpuacct-percpu'];
        }
        oneTemplate._json.settings['index.mapping.total_fields.limit'] = oneTemplate._json.settings['index-mapping-total_fields-limit'];
        oneTemplate._json.settings['index.refresh_interval'] = oneTemplate._json.settings['index-refresh_interval'];
        delete oneTemplate._json.settings['index-refresh_interval'];
        delete oneTemplate._json.settings['index-mapping-total_fields-limit'];
        const options = {
          name: oneTemplate._name,
          body: oneTemplate._json,
        };
        esClient.db.indices.putTemplate(options, callback);
      }, cb);
    });
  },
  
  /**
   * add mappings to es
   * @param {object} soajs: soajs object in req
   * @param {object} model: Mongo object
   * @param {object} esClient: elasticsearch connector object
   * @param {function} cb: callback function
   */
  putMapping(soajs, model, esClient, cb) {
    const combo = {
      collection: collections.analytics,
      conditions: {_type: 'mapping'},
    };
    model.findEntries(soajs, combo, (error, mappings) => {
      if (error) return cb(error);
      const mapping = {
        index: '.kibana',
        body: mappings._json,
      };
      esClient.db.indices.exists(mapping, (error, result) => {
        if (error || !result) {
          esClient.db.indices.create(mapping, err => cb(err, true));
        } else {
          return cb(null, true);
        }
      });
    });
  },
  
  
  /**
   * add metricbeat and filebeat visualizations
   * @param {object} soajs: soajs object in req
   * @param {object} esClient: elasticsearch connector object
   * @param {array} servicesList: list of all services
   * @param {object} env: environment object
   * @param {object} model: Mongo object
   * @param {function} cb: callback function
   */
  configureKibana(soajs, servicesList, esClient, env, model, cb) {
    let analyticsArray = [];
    let serviceEnv = env.code.toLowerCase();
    async.parallel({
        filebeat(pCallback) {
          async.each(servicesList, (oneService, callback) => {
            let serviceType;
            let serviceName,
              taskName;
            serviceEnv = serviceEnv.replace(/[\/*?"<>|,.-]/g, '_');
            if (oneService) {
              if (oneService.labels) {
                if (oneService.labels['soajs.service.repo.name']) {
                  serviceName = oneService.labels['soajs.service.repo.name'].replace(/[\/*?"<>|,.-]/g, '_');
                }
                if (oneService.labels['soajs.service.group'] === 'soajs-core-services') {
                  serviceType = (oneService.labels['soajs.service.repo.name'] === 'controller') ? 'controller' : 'service';
                } else if (oneService.labels['soajs.service.group'] === 'nginx') {
                  serviceType = 'nginx';
                  serviceName = 'nginx';
                } else {
                  return callback(null, true);
                }
                
                if (oneService.tasks.length > 0) {
                  async.forEachOf(oneService.tasks, (oneTask, key, call) => {
                    if (oneTask.status && oneTask.status.state && oneTask.status.state === 'running') {
                      taskName = oneTask.name;
                      taskName = taskName.replace(/[\/*?"<>|,.-]/g, '_');
                      if (key === 0) {
                        // filebeat-service-environment-*
                        analyticsArray = analyticsArray.concat(
                          [
                            {
                              index: {
                                _index: '.kibana',
                                _type: 'index-pattern',
                                _id: `filebeat-${serviceName}-${serviceEnv}-` + '*',
                              },
                            },
                            {
                              title: `filebeat-${serviceName}-${serviceEnv}-` + '*',
                              timeFieldName: '@timestamp',
                              fields: filebeatIndex.fields,
                              fieldFormatMap: filebeatIndex.fieldFormatMap,
                            },
                          ]
                        );
                      }
                      
                      const options = {
                          
                          $and: [
                            {
                              _type: {
                                $in: ['dashboard', 'visualization', 'search'],
                              },
                            },
                            {
                              _service: serviceType,
                            },
                          ],
                        }
                      ;
                      const combo = {
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
                              _index: '.kibana',
                              _type: oneRecord._type,
                              _id: oneRecord.id,
                            },
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
                  _index: '.kibana',
                  _type: 'index-pattern',
                  _id: 'metricbeat-*',
                },
              },
              {
                title: 'metricbeat-*',
                timeFieldName: '@timestamp',
                fields: metricbeatIndex.fields,
                fieldFormatMap: metricbeatIndex.fieldFormatMap,
              },
            ]
          );
          analyticsArray = analyticsArray.concat(
            [
              {
                index: {
                  _index: '.kibana',
                  _type: 'index-pattern',
                  _id: `filebeat-*-${serviceEnv}-*`,
                },
              },
              {
                title: `filebeat-*-${serviceEnv}-*`,
                timeFieldName: '@timestamp',
                fields: filebeatIndex.fields,
                fieldFormatMap: filebeatIndex.fieldFormatMap,
              },
            ]
          );
          const combo = {
            collection: collections.analytics,
            conditions: {
              _shipper: 'metricbeat',
            },
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
                    _index: '.kibana',
                    _type: onRecord._type,
                    _id: onRecord.id,
                  },
                };
                analyticsArray = analyticsArray.concat([recordIndex, onRecord._source]);
              });
            }
            return pCallback(null, true);
          });
        },
      },
      (err) => {
        if (err) {
          return cb(err);
        }
        es.esBulk(esClient, analyticsArray, cb);
      }
    );
  },
  
  /**
   * create deployment object
   * @param {string} soajs: req.soajs object
   * @param {string} config: configuration object
   * @param {string} model: mongo object
   * @param {string} service: elk file name
   * @param {object} catalogDeployment: catalog deployment object
   * @param {object} deployment: installer deployment object
   * @param {object} env: environment object
   * @param {object} settings: analytics settings record
   * @param {object} auto: object containing tasks done
   * @param {object} esCluster: elasticsearch cluster
   * @param {function} cb: callback function
   */
  getAnalyticsContent(soajs, config, model, service, catalogDeployment, deployment, env, auto, esCluster, cb) {
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
          memoryLimit: loadContent.deployConfig.memoryLimit,
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
          if (serviceParams.labels['soajs.service.mode'] === 'replicated') {
            serviceParams.labels['soajs.service.mode'] = 'deployment';
          } else {
            serviceParams.labels['soajs.service.mode'] = 'daemonset';
          }
          if (serviceParams.memoryLimit) {
            delete serviceParams.memoryLimit;
          }
          if (serviceParams.replication.mode === 'replicated') {
            serviceParams.replication.mode = 'deployment';
          } else if (serviceParams.replication.mode === 'global') {
            serviceParams.replication.mode = 'daemonset';
          }
          logNameSpace = `-service.${env.deployer.container.kubernetes[env.deployer.selected.split('.')[2]].namespace.default}`;
          
          if (env.deployer.container.kubernetes[env.deployer.selected.split('.')[2]].namespace.perService) {
            logNameSpace += `-${env.code.toLowerCase()}-logstash-service`;
          }
          // change published port name
          if (service === 'elastic') {
            serviceParams.ports[0].published = 30920;
          }
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
          serviceParams = serviceParams.replace(/%elasticsearch_url%/g, `${esCluster.URLParam.protocol}://${auto.getElasticClientNode}`);
        }
        if (service === 'filebeat') {
          serviceParams = serviceParams.replace(/%logNameSpace%/g, logNameSpace);
        }
        // if (service === "logstash" || service === "metricbeat") {
        // 	serviceParams = serviceParams.replace(/%elasticsearch_url%/g, auto.getElasticClientNode);
        // }
        serviceParams = serviceParams.replace(/%env%/g, env.code.toLowerCase());
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
        type: 'elk',
        
      };
      /**
       * name : name of the service (resolved to env-name, or name if allEnv is set to true)
       * env : environent variables
       * allEnv : if set true, service is not per env
       */
      switch (service) {
        case 'logstash':
          combo.conditions.name = 'Logstash Recipe';
          soajs.inputmaskData.custom = {
            name: 'logstash'
          };
          soajs.inputmaskData.deployConfig = {
            replication: {
              mode: 'replicated',
            },
          };
          break;
        case 'kibana':
          combo.conditions.name = 'Kibana Recipe';
          soajs.inputmaskData.custom = {
            name: 'soajs-kibana',
            allEnv: true,
            env: {
              ELASTICSEARCH_URL: `http://${auto.getElasticClientNode}`,
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
            allEnv: true,
          };
          soajs.inputmaskData.deployConfig = {
            replication: {
              mode: 'global',
            },
          };
          combo.conditions.name = 'Metricbeat Recipe';
          
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
        soajs.inputmaskData.env = env.code.toLowerCase();
        soajs.inputmaskData.recipe = recipe._id.toString();
        return call(null, true);
      });
    }
  },
  
};

module.exports = utils;
