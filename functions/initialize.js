/* jshint esversion: 6 */
'use strict';
const fs = require('fs');
const async = require('async');
const mSoajs = require('soajs');
const request = require('request');
// const deployer = require('soajs').drivers;
const deployer = require('soajs.core.drivers');
const utils = require('../utils/utils');
const filebeatIndex = require('../data/indexes/filebeat-index');
const metricbeatIndex = require('../data/indexes/metricbeat-index');

const collection = {
  analytics: 'analytics',
  catalogs: 'catalogs',
};

let counter = 0;
const lib = {
  /**
   * insert analytics data to mongo
   * @param {object} soajs: object in req
   * @param {object} model: Mongo object
   * @param {function} cb: callback function
   */
  insertMongoData(soajs, model, cb) {
    const comboFind = {};
    comboFind.collection = collection.analytics;
    comboFind.conditions = {
      _type: 'settings',
    };
    model.findEntry(soajs, comboFind, (error, response) => {
      if (error) {
        return cb(error);
      }
      const records = [];
      
      function importData(records, call) {
        const dataFolder = `${__dirname}/data/`;
        fs.readdir(dataFolder, (err, items) => {
          async.forEachOf(items, (item, key, callback) => {
            if (key === 0) {
              records = require(dataFolder + items[key]);
            } else {
              const arrayData = require(dataFolder + item);
              if (Array.isArray(arrayData) && arrayData.length > 0) {
                records = records.concat(arrayData);
              }
            }
            callback();
          }, () => {
            const comboInsert = {};
            comboInsert.collection = collection.analytics;
            comboInsert.record = records;
            if (records) {
              model.insertEntry(soajs, comboInsert, call);
            } else {
              return call(null, true);
            }
          });
        });
      }
      
      if (response && response.mongoImported) {
        return cb(null, true);
      }
      importData(records, (err) => {
        if (err) {
          return cb(err);
        }
        const combo = {
          collection: collection.analytics,
          conditions: {
            _type: 'settings',
          },
          fields: {
            $set: {
              mongoImported: true,
            },
          },
          options: {
            safe: true,
            multi: false,
            upsert: false,
          },
        };
        model.updateEntry(soajs, combo, cb);
      });
    });
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
          serviceParams = serviceParams.replace(/%elasticsearch_url%/g, `http://${auto.getElasticClientNode}`);
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
      combo.collection = collection.catalogs;
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
            name: 'kibana',
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
            name: 'metricbeat',
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
        soajs.inputmaskData.deployConfig.replication.mode = 'daemonset';
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
        console.log(JSON.stringify(soajs.inputmaskData, null, 2), 'soajs.inputmaskData');
        return call(null, true);
      });
    }
  },
  
  /**
   * check if soajs elasticsearch is deployed
   * @param {string} soajs: req.soajs object
   * @param {object} deployment: installer deployment object
   * @param {object} env: environment object
   * @param {string} model: mongo object
   * @param {object} auto: object containing tasks done
   * @param {function} cb: callback function
   */
  checkElasticsearch(soajs, deployment, env, model, auto, cb) {
    utils.printProgress('Checking Elasticsearch');
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
   * deploy elasticsearch
   * @param {string} soajs: req.soajs object
   * @param {string} config: configuration object
   * @param {string} mode: dashboard or installer
   * @param {object} deployment: deployment object
   * @param {object} env: environment object
   * @param {object} model: mongo object
   * @param {object} auto: object containing tasks done
   * @param {function} cb: callback function
   */
  deployElastic(soajs, config, mode, deployment, env, dashboard, settings, model, auto, cb) {
    utils.printProgress('Checking Elasticsearch');
    if (mode === 'dashboard') {
      lib.checkElasticsearch(soajs, deployment, env, model, auto, (err, deployed) => {
        if (err) {
          return cb(err);
        }
        if (deployed) {
          return cb(null, true);
        }
        if (soajs.inputmaskData.elasticsearch === 'local') {
          async.series({
            deploy(call) {
              deployElasticSearch(call);
            },
            updateDb(call) {
              utils.addEsClusterToDashboard(soajs, model, dashboard, env, settings, call);
            },
          }, (err, response) => {
            if (err) {
              return cb(err);
            }
            return cb(null, response.updateDb);
          });
        }
        else {
          deployElasticSearch(cb);
        }
      });
    } else {
      deployElasticSearch(cb);
    }
    function deployElasticSearch(call) {
      const combo = {};
      combo.collection = collection.analytics;
      combo.conditions = {
        _type: 'settings',
      };
      model.findEntry(soajs, combo, (error, settings) => {
        if (error) {
          return call(error);
        }
        if (settings && settings.elasticsearch &&
          // either elastic is deployed or its external
          (settings.elasticsearch.external || settings.elasticsearch.status === 'deployed')) {
          return call(null, true);
        }
        lib.getAnalyticsContent(soajs, config, model, 'elastic', null, deployment, env, null, null, (err, content) => {
          if (err) {
            return call(err);
          }
          const options = utils.buildDeployerOptions(env, soajs, model);
          options.params = content;
          async.parallel({
            deploy(callback) {
              deployer.deployService(options, callback);
            },
            update(callback) {
              settings.elasticsearch.status = 'deployed';
              combo.record = settings;
              model.saveEntry(soajs, combo, callback);
            },
          }, call);
        });
      });
    }
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
          lib.pingElastic(esClient, cb);
        }, 2000);
      } else {
        lib.infoElastic(esClient, cb);
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
          lib.infoElastic(esClient, cb);
        }, 3000);
      } else {
        return cb(null, true);
      }
    });
  },
  
  /**
   * check elasticsearch overall availability
   * @param {object} esClient: elasticsearch connector object
   * @param {object} auto: object containing tasks done
   * @param {function} cb: callback function
   */
  pingElasticsearch(soajs, esClient, auto, cb) {
    if (soajs.inputmaskData.elasticsearch === 'local'){
      esClient = new mSoajs.es(auto.deployElastic)
    }
    utils.printProgress('Checking Elasticsearch Availability');
    lib.pingElastic(esClient, function(err){
      if(err){
        return cb(err);
      }
      else {
        return cb(null, esClient);
      }
    });
    // add version to settings record
  },
  
  /**
   * check elasticsearch overall availability
   * @param {object} esClient: elasticsearch connector object
   * @param {object} esCluster: cluster info
   * @param {object} auto: object containing tasks done
   * @param {function} cb: callback function
   */
  getElasticClientNode(soajs, esClient, esCluster, auto, cb) {
    utils.printProgress('Get Elasticsearch Client node');
    let elasticAddress;
    if (soajs.inputmaskData.elasticsearch === 'local'){
      esClient = auto.pingElasticsearch;
      esCluster = auto.deployElastic;
    }
    function getNode(esCluster, nodes) {
      const servers = [];
      esCluster.servers.forEach((server) => {
        servers.push(`${server.host}:${server.port}`);
      });
      let coordinatingNode,
        masterNode;
      for (const oneNode in nodes) {
        if (nodes.hasOwnProperty(oneNode)) {
          if (servers.indexOf(nodes[oneNode].http.publish_address) !== -1) {
            const settings = nodes[oneNode].settings.node;
            if (settings.hasOwnProperty('master') && settings.master === 'true') {
              masterNode = nodes[oneNode].http.publish_address;
            }
            if (settings && settings.hasOwnProperty('data') && settings.data === 'false'
              && settings.hasOwnProperty('master') && settings.master === 'false'
              && settings.hasOwnProperty('ingest') && settings.ingest === 'false') {
              elasticAddress = nodes[oneNode].http.publish_address;
              break;
            }
          }
        }
      }
      if (coordinatingNode) {
        return coordinatingNode;
      } else if (masterNode) {
        return masterNode;
      }
      
      return null;
    }
    
    if (esCluster.servers.length > 1) {
      esClient.db.nodes.info({}, (err, res) => {
        if (err) {
          return cb(err);
        }
        elasticAddress = getNode(esCluster, res.nodes);
        if (!elasticAddress) {
          return cb('No eligible elasticsearch host found!');
        }
        return cb(null, elasticAddress);
      });
    } else {
      elasticAddress = `${esCluster.servers[0].host}:${esCluster.servers[0].port}`;
      return cb(null, elasticAddress);
    }
  },
  
  /**
   * add mappings and templates to es
   * @param {object} soajs: soajs object in req
   * @param {object} model: Mongo object
   * @param {object} esClient: elasticsearch connector object
   * @param {object} auto: object containing tasks done
   * @param {function} cb: callback function
   */
  setMapping(soajs, model, esClient, auto, cb) {
    if (soajs.inputmaskData.elasticsearch === 'local'){
      esClient = auto.pingElasticsearch;
    }
    utils.printProgress('Adding Mapping and templates');
    async.series({
      mapping(callback) {
        lib.putMapping(soajs, model, esClient, callback);
      },
      template(callback) {
        lib.putTemplate(soajs, model, esClient, callback);
      },
    }, cb);
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
      collection: collection.analytics,
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
      collection: collection.analytics,
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
   * add kibana visualizations to es
   * @param {object} soajs: soajs object in req
   * @param {object} deployment: deployment object
   * @param {object} esClient: elasticsearch connector object
   * @param {object} env: environment object
   * @param {object} model: Mongo object
   * @param {object} auto: object containing tasks done
   * @param {function} cb: callback function
   */
  addVisualizations(soajs, deployment, esClient, env, model, auto, cb) {
    if (soajs.inputmaskData.elasticsearch === 'local'){
      esClient = auto.pingElasticsearch;
    }
    utils.printProgress('dding Kibana Visualizations');
    const options = utils.buildDeployerOptions(env, soajs, model);
    options.params = {
      deployment
    };
    deployer.listServices(options, (err, servicesList) => {
      lib.configureKibana(soajs, servicesList, esClient, env, model, cb);
    });
  },
  
  /**
   * do es bulk operations
   * @param {object} esClient:elasticsearch connector object
   * @param {object} array: array of data
   * @param {function} cb: callback function
   */
  esBulk(esClient, array, cb) {
    esClient.bulk(array, cb);
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
                        collection: collection.analytics,
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
            collection: collection.analytics,
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
        lib.esBulk(esClient, analyticsArray, cb);
      }
    );
  },
  
  /**
   * deploy kibana service
   * @param {object} soajs: soajs object in req
   * @param {string} config: configuration object
   * @param {object} catalogDeployment: catalog deployment object
   * @param {object} env: environment object
   * @param {object} deployment: deployment object
   * @param {object} model: Mongo object
   * @param {object} auto: object containing tasks done
   * @param {function} cb: callback function
   */
  deployKibana(soajs, config, catalogDeployment, deployment, env, model, auto, cb) {
    utils.printProgress('Checking Kibana');
    const combo = {};
    combo.collection = collection.analytics;
    combo.conditions = {
      _type: 'settings',
    };
    model.findEntry(soajs, combo, (error, settings) => {
      if (error) {
        return cb(error);
      }
      if (settings && settings.kibana && settings.kibana.status === 'deployed') {
        utils.printProgress('Kibana found');
        return cb(null, true);
      }
      utils.printProgress('Deploying Kibana');
      lib.getAnalyticsContent(soajs, config, model, 'kibana', catalogDeployment, deployment, env, auto, null, (err, content) => {
        if (err) {
          return cb(err);
        }
        const options = utils.buildDeployerOptions(env, soajs, model);
        options.params = content;
        console.log(JSON.stringify(content, null, 2));
        async.parallel({
          deploy(call) {
            deployer.deployService(options, call);
          },
          update(call) {
            settings.kibana = {
              status: 'deployed',
            };
            combo.record = settings;
            model.saveEntry(soajs, combo, call);
          },
        }, cb);
      });
    });
  },
  
  /**
   * deploy logstash service
   * @param {object} soajs: soajs object in req
   * @param {string} config: configuration object
   * @param {object} catalogDeployment: catalog deployment object
   * @param {object} deployment: deployment object
   * @param {object} env: environment object
   * @param {object} model: Mongo object
   * @param {object} esCluster: elasticsearch cluster
   * @param {object} auto: object containing tasks done
   * @param {function} cb: callback function
   */
  deployLogstash(soajs, config, catalogDeployment, deployment, env, model, esCluster, auto, cb) {
    if (soajs.inputmaskData.elasticsearch === 'local'){
      esCluster = auto.deployElastic;
    }
    utils.printProgress('Checking Logstash');
    const combo = {};
    combo.collection = collection.analytics;
    combo.conditions = {
      _type: 'settings',
    };
    model.findEntry(soajs, combo, (error, settings) => {
      if (error) {
        return cb(error);
      }
      if (settings && settings.logstash && settings.logstash[env.code.toLowerCase()] && settings.logstash[env.code.toLowerCase()].status === 'deployed') {
        utils.printProgress('Logstash found');
        return cb(null, true);
      }
      lib.getAnalyticsContent(soajs, config, model, 'logstash', catalogDeployment, deployment, env, auto, esCluster, (err, content) => {
        if (err) {
          return cb(err);
        }
        utils.printProgress('Deploying Logstash');
        const options = utils.buildDeployerOptions(env, soajs, model);
        options.params = content;
        console.log(JSON.stringify(content, null, 2));
        async.parallel({
          deploy(call) {
            deployer.deployService(options, call);
          },
          update(call) {
            if (!settings.logstash) {
              settings.logstash = {};
            }
            settings.logstash[env.code.toLowerCase()] = {
              status: 'deployed',
            };
            combo.record = settings;
            model.saveEntry(soajs, combo, call);
          },
        }, cb);
      });
    });
  },
  
  /**
   * deploy filebeat service
   * @param {object} soajs: soajs object in req
   * @param {string} config: configuration object
   * @param {object} deployment: deployment object
   * @param {object} env: environment object
   * @param {object} model: Mongo object
   * @param {object} auto: object containing tasks done
   * @param {function} cb: callback function
   */
  deployFilebeat(soajs, config, deployment, env, model, auto, cb) {
    utils.printProgress('Checking Filebeat');
    const combo = {};
    combo.collection = collection.analytics;
    combo.conditions = {
      _type: 'settings',
    };
    model.findEntry(soajs, combo, (error, settings) => {
      if (error) {
        return cb(error);
      }
      if (settings && settings.filebeat && settings.filebeat[env.code.toLowerCase()] && settings.filebeat[env.code.toLowerCase()].status === 'deployed') {
        utils.printProgress('Filebeat found');
        return cb(null, true);
      }
      lib.getAnalyticsContent(soajs, config, model, 'filebeat', null, deployment, env, null, null, (err, content) => {
        if (err) {
          return cb(err);
        }
        utils.printProgress('Deploying Filebeat');
        const options = utils.buildDeployerOptions(env, soajs, model);
        options.params = content;
        console.log(JSON.stringify(content, null, 2));
        async.parallel({
          deploy(call) {
            deployer.deployService(options, call);
          },
          update(call) {
            if (!settings.filebeat) {
              settings.filebeat = {};
            }
            settings.filebeat[env.code.toLowerCase()] = {
              status: 'deployed',
            };
            combo.record = settings;
            model.saveEntry(soajs, combo, call);
          },
        }, cb);
      });
    });
  },
  
  /**
   * deploy metricbeat service
   * @param {object} soajs: soajs object in req
   * @param {string} config: configuration object
   * @param {object} catalogDeployment: catalog deployment object
   * @param {object} deployment: deployment object
   * @param {object} env: environment object
   * @param {object} esCluster: elasticsearch cluster
   * @param {object} auto: object containing tasks done
   * @param {object} model: Mongo object
   * @param {function} cb: callback function
   */
  deployMetricbeat(soajs, config, catalogDeployment, deployment, env, model, esCluster, auto, cb) {
    if (soajs.inputmaskData.elasticsearch === 'local'){
      esCluster = auto.deployElastic;
    }
    utils.printProgress('Checking Metricbeat');
    const combo = {};
    combo.collection = collection.analytics;
    combo.conditions = {
      _type: 'settings',
    };
    model.findEntry(soajs, combo, (error, settings) => {
      if (error) {
        return cb(error);
      }
      if (settings && settings.metricbeat && settings.metricbeat && settings.metricbeat.status === 'deployed') {
        utils.printProgress('Metricbeat found');
        return cb(null, true);
      }
      lib.getAnalyticsContent(soajs, config, model, 'metricbeat', catalogDeployment, deployment, env, auto, esCluster, (err, content) => {
        if (err) {
          return cb(err);
        }
        utils.printProgress('Deploying Metricbeat');
        const options = utils.buildDeployerOptions(env, soajs, model);
        options.params = content;
        console.log(JSON.stringify(content, null, 2));
        async.parallel({
          deploy(call) {
            deployer.deployService(options, call);
          },
          update(call) {
            if (!settings.metricbeat) {
              settings.metricbeat = {};
            }
            settings.metricbeat = {
              status: 'deployed',
            };
            combo.record = settings;
            model.saveEntry(soajs, combo, call);
          },
        }, cb);
      });
    });
  },
  
  /**
   * check availablity of all services
   * @param {object} soajs: soajs object in req
   * @param {object} deployment: deployment object
   * @param {object} env: environment object
   * @param {object} model: Mongo object
   * @param {object} auto: object containing tasks done
   * @param {function} cb: callback function
   */
  checkAvailability(soajs, deployment, env, model, auto, cb) {
    const options = utils.buildDeployerOptions(env, soajs, model);
    let counter = 0;
    options.params = {
      deployment,
    };
    const flk = ['kibana', `${env.code.toLowerCase()}-logstash`, `${env.code.toLowerCase()}-filebeat`, 'metricbeat'];
    
    function check(cb) {
      utils.printProgress('Finalizing', counter++);
      deployer.listServices(options, (err, servicesList) => {
        if (err) {
          return cb(err);
        }
        const failed = [];
        servicesList.forEach((oneService) => {
          if (flk.indexOf(oneService.name) === !-1) {
            let status = false;
            oneService.tasks.forEach((oneTask) => {
              if (oneTask.status.state === 'running') {
                status = true;
              }
            });
            if (!status) {
              failed.push(oneService.name);
            }
          }
        });
        if (failed.length !== 0) {
          setTimeout(() => {
            check(cb);
          }, 1000);
        } else {
          return cb(null, true);
        }
      });
    }
    
    return check(cb);
  },
  
  /**
   * add default index to kibana
   * @param {object} soajs: soajs object in req
   * @param {object} deployment: deployment object
   * @param {object} esClient: elasticsearch connector object
   * @param {object} env: environment object
   * @param {object} model: Mongo object
   * @param {object} auto: object containing tasks done
   * @param {function} cb: callback function
   */
  setDefaultIndex(soajs, deployment, esClient, env, model, auto, cb) {
    if (soajs.inputmaskData.elasticsearch === 'local'){
      esClient = auto.pingElasticsearch;
    }
    let counter = 0;
    const index = {
      index: '.kibana',
      type: 'config',
      body: {
        doc: {defaultIndex: 'metricbeat-*'},
      },
    };
    const condition = {
      index: '.kibana',
      type: 'config',
    };
    const combo = {
      collection: collection.analytics,
      conditions: {_type: 'settings'},
    };
    const options = {
      method: 'GET',
    };
    
    function getKibanaUrl(cb) {
      utils.printProgress('Waiting for kibana', counter++);
      let url;
      if (deployment && deployment.external) {
        url = `http://${process.env.CONTAINER_HOST}:32601/status`;
        return cb(null, url);
      }
      
      const options = utils.buildDeployerOptions(env, soajs, model);
      deployer.listServices(options, (err, servicesList) => {
        if (err) {
          return cb(err);
        }
        servicesList.forEach((oneService) => {
          if (oneService.labels['soajs.service.name'] === 'kibana') {
            url = `http://${oneService.name}:5601/status`;
          }
        });
        return cb(null, url);
      });
    }
    
    // added check for availability of kibana
    function kibanaStatus(cb) {
      utils.printProgress('Waiting for kibana', counter++);
      request(options, (error, response) => {
        if (error || !response) {
          setTimeout(() => {
            kibanaStatus(cb);
          }, 3000);
        } else {
          return cb(null, true);
        }
      });
    }
    
    function kibanaIndex(cb) {
      utils.printProgress('Waiting for kibana', counter++);
      esClient.db.search(condition, (err, res) => {
        if (err) {
          return cb(err);
        }
        if (res && res.hits && res.hits.hits && res.hits.hits.length > 0) {
          return cb(null, res);
        }
        setTimeout(() => {
          kibanaIndex(cb);
        }, 500);
      });
    }
  
    getKibanaUrl((err, url) => {
      if (err) {
        cb(err);
      } else {
        options.url = url;
        kibanaStatus(() => {
          kibanaIndex((error, kibanaRes) => {
            if (error) {
              return cb(error);
            }
            model.findEntry(soajs, combo, (err, result) => {
              if (err) {
                return cb(err);
              }
              index.id = kibanaRes.hits.hits[0]._id;
              async.parallel({
                updateES(call) {
                  esClient.db.update(index, call);
                },
                updateSettings(call) {
                  const criteria = {
                    $set: {
                      kibana: {
                        version: index.id,
                        status: 'deployed',
                        port: '32601',
                      },
                    },
                  };
                  result.env[env.code.toLowerCase()] = true;
                  criteria.$set.env = result.env;
                  const options = {
                    safe: true,
                    multi: false,
                    upsert: false,
                  };
                  combo.fields = criteria;
                  combo.options = options;
                  model.updateEntry(soajs, combo, call);
                },
              }, cb);
            });
          });
        });
      }
    });
  },
};

module.exports = lib;
