/* jshint esversion: 6 */
'use strict';
const async = require('async');
const request = require('request');
const fs = require('fs');
// const deployer = require('soajs').drivers;
const deployer = require('soajs.core.drivers');
const utils = require('../utils/utils');
const kibanaConfig = require('../data/services/elk/kibana.js');
const recipes = require('../data/recipes/index');
const collection = {
  analytics: 'analytics',
  catalogs: 'catalogs',
};
const lib = {
  /**
   * insert analytics data to mongo
   * @param {object} opts: object
   * @param {function} cb: callback function
   */
  insertMongoData(opts, cb) {
    const soajs = opts.soajs;
    const model = opts.model;
    const analyticsSettings = opts.analyticsSettings;
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
    
    async.parallel({
      "import": function (callback) {
        if (analyticsSettings && analyticsSettings.mongoImported) {
          return callback(null, true);
        }
        importData(records, (err) => {
          if (err) {
            return callback(err);
          }
          settings.mongoImported = true;
          const combo = {
            "collection": collection.analytics,
            "record": analyticsSettings
          };
          model.saveEntry(soajs, combo, callback);
        });
      },
      "checkRecipes": function (callback) {
        const recipeCondition = {
          "collection": collection.catalogs,
          "conditions": {
            "$and": [
              {
                "$or": [
                  {
                    "name": "Kibana Recipe",
                    "subtype": "kibana",
                  },
                  {
                    "name": "Logstash Recipe",
                    "subtype": "logstash"
                  },
                  {
                    "name": "Metricbeat Recipe",
                    "subtype": "metricbeat"
                  }
                ]
              },
              {
                "type": "system",
                "locked": true
              }
            ]
          },
          "fields": {
            "name": 1
          }
        };
        model.findEntries(soajs, recipeCondition, (err, result) => {
          if (err) {
            return callback(err);
          }
          const recipesNames = ["Kibana Recipe", "Logstash Recipe", "Metricbeat Recipe"];
          if (result.length !== 3) {
            let resultNames = [];
            let final = recipesNames;
            if (result.length > 0) {
              resultNames = result.map(x => (x.name ? x.name : null));
              final = _.difference(recipesNames, resultNames);
            }
            recipeCondition.record = recipes.filter(oneRecipe => {
              return (final.indexOf(oneRecipe.name) !== -1);
            });
            model.insertEntry(soajs, recipeCondition, callback);
          }
          else {
            callback(null, true);
          }
        });
      }
    }, cb);
  },
  
  /**
   * deploy elasticsearch
   * @param {object} opts: object
   * @param {function} cb: callback function
   */
  deployElastic(opts, cb) {
    const soajs = opts.soajs;
    const config = opts.config;
    const envCode = opts.envCode;
    const mode = opts.mode;
    const env = opts.soajs.registry;
    const analyticsSettings = opts.analyticsSettings;
    const model = opts.model;
    utils.printProgress(soajs, 'Deploying Elasticsearch...');
    if (mode === 'dashboard') {
      utils.checkElasticsearch(opts, (err, deployed) => {
        if (err) {
          return cb(err);
        }
        if (deployed) {
          return cb(null, true);
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
      if (analyticsSettings && analyticsSettings.elasticsearch
        && analyticsSettings.elasticsearch.status === "deployed") {
        //purge data since elasticsearch is not deployed
        utils.printProgress(soajs, "Elasticsearch is already deployed...");
        return cb(null, true)
      }
      else {
        utils.getAnalyticsContent(opts, 'elastic', (err, content) => {
          if (err) {
            return call(err);
          }
          const options = utils.buildDeployerOptions(env, envCode, model);
          options.params = content;
          
          
          deployer.deployService(options, function (error) {
            if (error) {
              utils.printProgress(soajs, error, "error");
              analyticsSettings.elasticsearch = {};
            }
            else {
              config.purge = true;
              analyticsSettings.elasticsearch.status = "deployed";
            }
            combo.record = analyticsSettings;
            model.saveEntry(soajs, combo, (mongoError) => {
              if (mongoError) {
                return call(mongoError);
              }
              return call(error, true);
            });
          });
        });
      }
    }
  },
  
  /**
   * @param {string} opts:  object
   * @param {function} cb: callback function
   */
  pingElasticsearch(opts, cb) {
    utils.printProgress(opts.soajs, 'Checking Elasticsearch Availability...');
    utils.pingElastic(opts, cb);
    // add version to settings record
  },
  
  /**
   * @param {object} opts: object containing tasks done
   * @param {function} cb: callback function
   */
  getElasticClientNode(opts, cb) {
    const soajs = opts.soajs;
    const esClient = opts.esClient;
    const esCluster = opts.esDbInfo.esCluster;
    utils.printProgress(soajs, 'Get Elasticsearch Client node...');
    let elasticAddress;
    
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
        opts.elasticAddress = getNode(esCluster, res.nodes);
        if (!opts.elasticAddress) {
          return cb('No eligible elasticsearch host found!');
        }
        return cb(null, true);
      });
    } else {
      opts.elasticAddress = `${esCluster.servers[0].host}:${esCluster.servers[0].port}`;
      return cb(null, true);
    }
  },
  
  /**
   * add mappings and templates to es
   * @param {object} opts:  object
   * @param {function} cb: callback function
   */
  setMapping(opts, cb) {
    const soajs = opts.soajs;
    utils.purgeElastic(opts, (err) => {
      if (err) {
        return cb(err);
      }
      utils.printProgress(soajs, 'Adding Mapping and templates...');
      //add purge mappings and templates
      async.series({
        mapping(callback) {
          utils.putMapping(opts, callback);
        },
        template(callback) {
          utils.putTemplate(opts, callback);
        },
      }, cb);
    });
  },
  
  
  /**
   * add kibana visualizations to es
   * @param {object} opts: object
   * @param {function} cb: callback function
   */
  addVisualizations(opts, cb) {
    const soajs = opts.soajs;
    const deployment = opts.deployment;
    const env = opts.soajs.registry;
    const model = opts.model;
    const envCode = opts.envCode;
    utils.printProgress(soajs, 'Adding Kibana Visualizations...');
    const options = utils.buildDeployerOptions(env, envCode, model);
    options.params = {
      deployment
    };
    deployer.listServices(options, (err, servicesList) => {
      utils.configureKibana(opts, servicesList, cb);
    });
  },
  
  /**
   * deploy kibana service
   * @param {object} opts: object
   * @param {function} cb: callback function
   */
  deployKibana(opts, cb) {
    const soajs = opts.soajs;
    const env = opts.soajs.registry;
    const analyticsSettings = opts.analyticsSettings;
    const model = opts.model;
    const envCode = opts.envCode;
    utils.printProgress(soajs, 'Checking Kibana...');
    const combo = {};
    combo.collection = collection.analytics;
    combo.conditions = {
      _type: 'settings',
    };
    
    if (analyticsSettings && analyticsSettings.kibana && analyticsSettings.kibana.status === 'deployed') {
      utils.printProgress(soajs, 'Kibana found...');
      return cb(null, true);
    }
    utils.printProgress(soajs, 'Deploying Kibana...');
    
    utils.getAnalyticsContent(opts, 'kibana', (err, content) => {
      if (err) {
        return cb(err);
      }
      const options = utils.buildDeployerOptions(env, envCode, model);
      options.params = content;
      
      async.parallel({
        deploy(call) {
          deployer.deployService(options, call);
        },
        update(call) {
          analyticsSettings.kibana = {
            status: 'deployed',
          };
          combo.record = analyticsSettings;
          model.saveEntry(soajs, combo, call);
        },
      }, function (err) {
        return cb(err, true)
      });
    });
    
  },
  
  /**
   * @param {object} opts: object
   * @param {function} cb: callback function
   */
  deployLogstash(opts, cb) {
    const soajs = opts.soajs;
    const env = opts.soajs.registry;
    const envCode = opts.envCode;
    const analyticsSettings = opts.analyticsSettings;
    const model = opts.model;
    utils.printProgress(soajs, 'Checking Logstash...');
    const combo = {};
    combo.collection = collection.analytics;
    combo.conditions = {
      _type: 'settings',
    };
    
    if (analyticsSettings && analyticsSettings.logstash && analyticsSettings.logstash[envCode] && analyticsSettings.logstash[envCode].status === 'deployed') {
      utils.printProgress(soajs, 'Logstash found...');
      return cb(null, true);
    }
    utils.getAnalyticsContent(opts, 'logstash', (err, content) => {
      if (err) {
        return cb(err);
      }
      utils.printProgress(soajs, 'Deploying Logstash...');
      const options = utils.buildDeployerOptions(env, envCode, model);
      options.params = content;
      async.series({
        deploy(call) {
          deployer.deployService(options, call);
        },
        update(call) {
          if (!analyticsSettings.logstash) {
            analyticsSettings.logstash = {};
          }
          analyticsSettings.logstash[envCode] = {
            status: 'deployed',
          };
          combo.record = analyticsSettings;
          model.saveEntry(soajs, combo, call);
        },
      }, cb);
    });
    
  },
  
  /**
   * deploy filebeat service
   * @param {object} opts: object containing tasks done
   * @param {function} cb: callback function
   */
  deployFilebeat(opts, cb) {
    const soajs = opts.soajs;
    const env = opts.soajs.registry;
    const envCode = opts.envCode;
    const analyticsSettings = opts.analyticsSettings;
    const model = opts.model;
    utils.printProgress(soajs, 'Checking Filebeat...');
    const combo = {};
    combo.collection = collection.analytics;
    combo.conditions = {
      _type: 'settings',
    };
    
    if (analyticsSettings && analyticsSettings.filebeat && analyticsSettings.filebeat[envCode] && analyticsSettings.filebeat[envCode].status === 'deployed') {
      utils.printProgress(soajs, 'Filebeat found...');
      return cb(null, true);
    }
    utils.getAnalyticsContent(opts, 'filebeat', (err, content) => {
      if (err) {
        return cb(err);
      }
      utils.printProgress(soajs, 'Deploying Filebeat...');
      const options = utils.buildDeployerOptions(env, envCode, model);
      options.params = content;
      async.series({
        deploy(call) {
          deployer.deployService(options, call);
        },
        update(call) {
          if (!analyticsSettings.filebeat) {
            analyticsSettings.filebeat = {};
          }
          analyticsSettings.filebeat[envCode] = {
            status: 'deployed',
          };
          combo.record = analyticsSettings;
          model.saveEntry(soajs, combo, call);
        },
      }, cb);
    });
  },
  
  /**
   * deploy metricbeat service
   * @param {object} opts: object
   * @param {function} cb: callback function
   */
  deployMetricbeat(opts, cb) {
    const soajs = opts.soajs;
    const envCode = opts.envCode;
    const env = opts.soajs.registry;
    const analyticsSettings = opts.analyticsSettings;
    const model = opts.model;
    utils.printProgress(soajs, 'Checking Metricbeat...');
    const combo = {};
    combo.collection = collection.analytics;
    combo.conditions = {
      _type: 'settings',
    };
    //if kubernetes no need
    if (env.deployer.selected.indexOf("container.kubernetes") !== -1) {
      return cb(null, true);
    }
    if (analyticsSettings && analyticsSettings.metricbeat && analyticsSettings.metricbeat && analyticsSettings.metricbeat.status === 'deployed') {
      utils.printProgress(soajs, 'Metricbeat found...');
      return cb(null, true);
    }
    utils.getAnalyticsContent(opts, 'metricbeat', (err, content) => {
      if (err) {
        return cb(err);
      }
      utils.printProgress(soajs, 'Deploying Metricbeat...');
      const options = utils.buildDeployerOptions(env, envCode, model);
      options.params = content;
      async.series({
        deploy(call) {
          deployer.deployService(options, call);
        },
        update(call) {
          if (!analyticsSettings.metricbeat) {
            analyticsSettings.metricbeat = {};
          }
          analyticsSettings.metricbeat = {
            status: 'deployed',
          };
          combo.record = analyticsSettings;
          model.saveEntry(soajs, combo, call);
        },
      }, cb);
    });
  },
  
  /**
   * check availablity of all services
   * @param {object} context: object
   * @param {function} cb: callback function
   */
  checkAvailability(opts, cb) {
    let soajs = opts.soajs;
    let env = opts.soajs.registry;
    let deployment = opts.deployment;
    let envCode = opts.envCode;
    let model = opts.model;
    let tracker = opts.tracker;
    const options = utils.buildDeployerOptions(env, envCode, model);
    options.params = {
      deployment,
    };
    
    let flk = ['soajs-kibana', `${envCode}-logstash`, `${envCode}-filebeat`, 'soajs-metricbeat'];
    
    //if kubernetes no need
    if (env.deployer.selected.indexOf("container.kubernetes") !== -1) {
      flk = ["soajs-kibana", `${envCode}-logstash`, `${envCode}-filebeat`];
    }
    
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
          tracker[envCode].counterAvailability++;
          if (tracker[envCode].counterAvailability > 150) {
            utils.printProgress(soajs, failed.join(" , ") + "were/was not deployed... exiting", "error");
            return cb(new Error(failed.join(" , ") + "were/was not deployed... exiting"));
          }
          else {
            setTimeout(() => {
              return lib.checkAvailability(opts, cb);
            }, 1000);
          }
        } else {
          return cb(null, true);
        }
      });
    }
    
    return check(cb);
  },
  
  /**
   * add default index to kibana
   * @param {object} opts: object containing tasks done
   * @param {function} cb: callback function
   */
  setDefaultIndex(opts, cb) {
    let soajs = opts.soajs;
    let deployment = opts.deployment;
    let env = opts.soajs.registry;
    let esClient = opts.esClient;
    let envCode = opts.envCode;
    let model = opts.model;
    //this is not done yet
    utils.printProgress(soajs, 'Waiting for kibana...');
    let counter = 0;
    const index = {
      index: '.soajs-kibana',
      type: 'config',
      body: {
        doc: {defaultIndex: 'filebeat-*'},
      },
    };
    const condition = {
      index: '.soajs-kibana',
      type: 'config',
    };
    const combo = {
      collection: collection.analytics,
      conditions: {_type: 'settings'},
    };
    const options = {
      method: 'GET',
    };
    const esCluster = opts.esDbInfo.esCluster;
    
    if (esCluster.credentials && esCluster.credentials.username && esCluster.credentials.password) {
      options.headers = {
        "Authorization": utils.generateBasicAuth(opts.credentials)
      }
    }
    let kibanaPort = kibanaConfig.deployConfig.ports[0].target;
    let externalKibana = kibanaConfig.deployConfig.ports[0].published;
    
    function getKibanaUrl(cb) {
      let url;
      if (deployment && deployment.external) {
        url = `http://${process.env.CONTAINER_HOST}:${externalKibana}/api/status`;
        return cb(null, url);
      }
      
      const options = utils.buildDeployerOptions(env, envCode, model);
      deployer.listServices(options, (err, servicesList) => {
        if (err) {
          return cb(err);
        }
        servicesList.forEach((oneService) => {
          if (oneService.labels['soajs.service.name'] === 'soajs-kibana') {
            if (env.deployer.selected.split('.')[1] === 'kubernetes') {
              url = `http://${oneService.name}-service:${kibanaPort}/api/status`;
            }
            else {
              url = `http://${oneService.name}:${kibanaPort}/api/status`;
            }
          }
        });
        return cb(null, url);
      });
    }
    
    // added check for availability of kibana
    function kibanaStatus(cb) {
      request(options, (error, response) => {
        if (error || !response
          || !(response && response.body && response.body.status && response.body.status.overall && response.body.status.overall.state === "green")) {
          setTimeout(() => {
            if (counter > 150) { // wait 5 min
              cb(error);
            }
            counter++;
            kibanaStatus(cb);
          }, 3000);
        } else {
          counter = 0;
          return cb(error, response);
        }
      });
    }
    

    getKibanaUrl((err, url) => {
      if (err) {
        cb(err);
      } else {
        options.url = url;
        kibanaStatus((err, kibanaRes) => {
          if (err) {
            return cb(err);
          }
            model.findEntry(soajs, combo, (err, result) => {
              if (err) {
                return cb(err);
              }

              index.id = kibanaRes.body.version;
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
                  result.env[envCode] = true;
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
      }
    });
  },
};

module.exports = lib;
