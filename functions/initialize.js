/* jshint esversion: 6 */
'use strict';
const async = require('async');
const mSoajs = require('soajs');
const request = require('request');
// const deployer = require('soajs').drivers;
const deployer = require('soajs.core.drivers');
const utils = require('../utils/utils');
const es = require('../utils/es');


const collection = {
  analytics: 'analytics',
  catalogs: 'catalogs',
};
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
   * deploy elasticsearch
   * @param {string} soajs: req.soajs object
   * @param {string} config: configuration object
   * @param {string} mode: dashboard or installer
   * @param {object} deployment: deployment object
   * @param {object} env: environment object
   * @param {object} dashboard: dashboard environment object
   * @param {object} settings: settings object
   * @param {object} model: mongo object
   * @param {object} auto: object containing tasks done
   * @param {function} cb: callback function
   */
  deployElastic(soajs, config, mode, deployment, env, dashboard, settings, model, auto, cb) {
    utils.printProgress(soajs, 'Deploying Elasticsearch...');
    if (mode === 'dashboard') {
      utils.checkElasticsearch(soajs, deployment, env, model, (err, deployed) => {
        if (err) {
          return cb(err);
        }
        if (deployed) {
          return cb(null, true);
        }
        if (soajs.inputmaskData && soajs.inputmaskData.elasticsearch === 'local') {
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
        utils.getAnalyticsContent(soajs, config, model, 'elastic', null, deployment, env, null, null, (err, content) => {
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
   * @param {string} soajs: req.soajs object
   * check elasticsearch overall availability
   * @param {object} esClient: elasticsearch connector object
   * @param {object} auto: object containing tasks done
   * @param {function} cb: callback function
   */
  pingElasticsearch(soajs, esClient, auto, cb) {
    if (soajs.inputmaskData && soajs.inputmaskData.elasticsearch === 'local') {
      esClient = new mSoajs.es(auto.deployElastic)
    }
    utils.printProgress(soajs, 'Checking Elasticsearch Availability...');
    utils.pingElastic(esClient, function (err) {
      if (err) {
        return cb(err);
      }
      else {
        return cb(null, esClient);
      }
    });
    // add version to settings record
  },
  
  /**
   * @param {string} soajs: req.soajs object
   * check elasticsearch overall availability
   * @param {object} esClient: elasticsearch connector object
   * @param {object} esCluster: cluster info
   * @param {object} auto: object containing tasks done
   * @param {function} cb: callback function
   */
  getElasticClientNode(soajs, esClient, esCluster, auto, cb) {
    utils.printProgress(soajs, 'Get Elasticsearch Client node...');
    let elasticAddress;
    if (soajs.inputmaskData && soajs.inputmaskData.elasticsearch === 'local') {
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
    if (soajs.inputmaskData && soajs.inputmaskData.elasticsearch === 'local') {
      esClient = auto.pingElasticsearch;
    }
    utils.printProgress(soajs, 'Adding Mapping and templates...');
    async.series({
      mapping(callback) {
        utils.putMapping(soajs, model, esClient, callback);
      },
      template(callback) {
        utils.putTemplate(soajs, model, esClient, callback);
      },
    }, cb);
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
    if (soajs.inputmaskData && soajs.inputmaskData.elasticsearch === 'local') {
      esClient = auto.pingElasticsearch;
    }
    utils.printProgress(soajs, 'Adding Kibana Visualizations...');
    const options = utils.buildDeployerOptions(env, soajs, model);
    options.params = {
      deployment
    };
    deployer.listServices(options, (err, servicesList) => {
      utils.configureKibana(soajs, servicesList, esClient, env, model, cb);
    });
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
  deployKibana(soajs, config, catalogDeployment, deployment, env, model, esCluster, auto, cb) {
    if (soajs.inputmaskData && soajs.inputmaskData.elasticsearch === 'local') {
      esCluster = auto.deployElastic;
    }
    utils.printProgress(soajs, 'Checking Kibana...');
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
        utils.printProgress(soajs, 'Kibana found...');
        return cb(null, true);
      }
      utils.printProgress(soajs, 'Deploying Kibana...');
      utils.getAnalyticsContent(soajs, config, model, 'kibana', catalogDeployment, deployment, env, auto, esCluster, (err, content) => {
        if (err) {
          return cb(err);
        }
        const options = utils.buildDeployerOptions(env, soajs, model);
        options.params = content;
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
        }, function (err) {
          return cb(err, true)
        });
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
    if (soajs.inputmaskData && soajs.inputmaskData.elasticsearch === 'local') {
      esCluster = auto.deployElastic;
    }
    utils.printProgress(soajs, 'Checking Logstash...');
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
        utils.printProgress(soajs, 'Logstash found...');
        return cb(null, true);
      }
      utils.getAnalyticsContent(soajs, config, model, 'logstash', catalogDeployment, deployment, env, auto, esCluster, (err, content) => {
        if (err) {
          return cb(err);
        }
        utils.printProgress(soajs, 'Deploying Logstash...');
        const options = utils.buildDeployerOptions(env, soajs, model);
        options.params = content;
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
    utils.printProgress(soajs, 'Checking Filebeat...');
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
        utils.printProgress(soajs, 'Filebeat found...');
        return cb(null, true);
      }
      utils.getAnalyticsContent(soajs, config, model, 'filebeat', null, deployment, env, null, null, (err, content) => {
        if (err) {
          return cb(err);
        }
        utils.printProgress(soajs, 'Deploying Filebeat...');
        const options = utils.buildDeployerOptions(env, soajs, model);
        options.params = content;
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
    if (soajs.inputmaskData && soajs.inputmaskData.elasticsearch === 'local') {
      esCluster = auto.deployElastic;
    }
    utils.printProgress(soajs, 'Checking Metricbeat...');
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
        utils.printProgress(soajs, 'Metricbeat found...');
        return cb(null, true);
      }
      utils.getAnalyticsContent(soajs, config, model, 'metricbeat', catalogDeployment, deployment, env, auto, esCluster, (err, content) => {
        if (err) {
          return cb(err);
        }
        utils.printProgress(soajs, 'Deploying Metricbeat...');
        const options = utils.buildDeployerOptions(env, soajs, model);
        options.params = content;
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
    options.params = {
      deployment,
    };
    const flk = ['soajs-kibana', `${env.code.toLowerCase()}-logstash`, `${env.code.toLowerCase()}-filebeat`, 'soajs-metricbeat'];
    
    function check(cb) {
      utils.printProgress(soajs, 'Finalizing...');
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
    utils.printProgress(soajs, 'Waiting for kibana...');
    let counter = 0;
    if (soajs.inputmaskData && soajs.inputmaskData.elasticsearch === 'local') {
      esClient = auto.pingElasticsearch;
    }
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
    let kibanaPort = "5601";
    let externalKibana = "32601";
    
    function getKibanaUrl(cb) {
      let url;
      if (deployment && deployment.external) {
        url = `http://${process.env.CONTAINER_HOST}:${externalKibana}/status`;
        return cb(null, url);
      }
      
      const options = utils.buildDeployerOptions(env, soajs, model);
      deployer.listServices(options, (err, servicesList) => {
        if (err) {
          return cb(err);
        }
        servicesList.forEach((oneService) => {
          if (oneService.labels['soajs.service.name'] === 'soajs-kibana') {
            if (env.deployer.selected.split('.')[1] === 'kubernetes') {
              url = `http://${oneService.name}-service:${kibanaPort}/status`;
            }
            else {
              url = `http://${oneService.name}:${kibanaPort}/status`;
            }
          }
        });
        return cb(null, url);
      });
    }
    
    // added check for availability of kibana
    function kibanaStatus(cb) {
      request(options, (error, response) => {
        if (error || !response) {
          setTimeout(() => {
            if (counter > 150) { // wait 5 min
              cb(error);
            }
            counter++;
            kibanaStatus(cb);
          }, 3000);
        } else {
          counter = 0;
          return cb(null, true);
        }
      });
    }
    
    function kibanaIndex(cb) {
      esClient.db.search(condition, (err, res) => {
        if (err) {
          return cb(err);
        }
        if (res && res.hits && res.hits.hits && res.hits.hits.length > 0) {
          return cb(null, res);
        }
        setTimeout(() => {
          if (counter > 150) { // wait 5 min
            cb(err);
          }
          counter++;
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
                        port: `${externalKibana}`,
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
