/* jshint esversion: 6 */
'use strict';
const async = require('async');
const request = require('request');
const fs = require('fs');
// const deployer = require('soajs').drivers;
const deployer = require('soajs.core.drivers');
const utils = require('../utils/utils');
const es = require('../utils/es');

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
            "$and" : [
              {
                "$or": [
                  {
                    "name": "Kibana Recipe",
                    "subType": "kibana",
                  },
                  {
                    "name": "Logstash Recipe",
                    "subType": "logstash"
                  },
                  {
                    "name": "Metricbeat Recipe",
                    "subType": "metricbeat"
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
          if (result.length !== 3){
            let resultNames = [];
            let final = recipes;
            if (result.length > 0){
              resultNames = result.map(x => (x.name ? x.name : null));
              final = _.difference (recipesNames, resultNames);
            }
            recipeCondition.record = recipes.filter(oneRecipe => {
              return (final.indexOf(oneRecipe) !== -1);
            });
            model.insertEntry(soajs, recipeCondition, callback);
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
    const mode = opts.mode;
    const env = opts.envRecord;
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
        soajs.log.debug("Elasticsearch is already deployed...");
        return cb(null, true)
      }
      else {
        utils.getAnalyticsContent(opts, 'elastic', (err, content) => {
          if (err) {
            return call(err);
          }
          const options = utils.buildDeployerOptions(env, model);
          options.params = content;
          
          
          deployer.deployService(options, function (error) {
            if (error) {
              soajs.log.error(error);
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
    const env = opts.envRecord;
    const model = opts.model;
    utils.printProgress(soajs, 'Adding Kibana Visualizations...');
    const options = utils.buildDeployerOptions(env, model);
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
    const env = opts.envRecord;
    const analyticsSettings = opts.analyticsSettings;
    const model = opts.model;
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
      const options = utils.buildDeployerOptions(env, model);
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
    const env = opts.envRecord;
    const analyticsSettings = opts.analyticsSettings;
    const model = opts.model;
    utils.printProgress(soajs, 'Checking Logstash...');
    const combo = {};
    combo.collection = collection.analytics;
    combo.conditions = {
      _type: 'settings',
    };
    
    if (analyticsSettings && analyticsSettings.logstash && analyticsSettings.logstash[env.environment.toLowerCase()] && analyticsSettings.logstash[env.environment.toLowerCase()].status === 'deployed') {
      utils.printProgress(soajs, 'Logstash found...');
      return cb(null, true);
    }
    utils.getAnalyticsContent(opts, 'logstash', (err, content) => {
      if (err) {
        return cb(err);
      }
      utils.printProgress(soajs, 'Deploying Logstash...');
      const options = utils.buildDeployerOptions(env, model);
      options.params = content;
      async.parallel({
        deploy(call) {
          deployer.deployService(options, call);
        },
        update(call) {
          if (!analyticsSettings.logstash) {
            analyticsSettings.logstash = {};
          }
          analyticsSettings.logstash[env.environment.toLowerCase()] = {
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
    const env = opts.envRecord;
    const analyticsSettings = opts.analyticsSettings;
    const model = opts.model;
    utils.printProgress(soajs, 'Checking Filebeat...');
    const combo = {};
    combo.collection = collection.analytics;
    combo.conditions = {
      _type: 'settings',
    };
    
    if (analyticsSettings && analyticsSettings.filebeat && analyticsSettings.filebeat[env.environment.toLowerCase()] && analyticsSettings.filebeat[env.environment.toLowerCase()].status === 'deployed') {
      utils.printProgress(soajs, 'Filebeat found...');
      return cb(null, true);
    }
    utils.getAnalyticsContent(opts, 'filebeat', (err, content) => {
      if (err) {
        return cb(err);
      }
      utils.printProgress(soajs, 'Deploying Filebeat...');
      const options = utils.buildDeployerOptions(env, model);
      options.params = content;
      async.parallel({
        deploy(call) {
          deployer.deployService(options, call);
        },
        update(call) {
          if (!analyticsSettings.filebeat) {
            analyticsSettings.filebeat = {};
          }
          analyticsSettings.filebeat[env.environment.toLowerCase()] = {
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
    const env = opts.envRecord;
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
      const options = utils.buildDeployerOptions(env, model);
      options.params = content;
      async.parallel({
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
  checkAvailability(context, cb) {
    let soajs = context.soajs;
    let env = context.envRecord;
    let deployment = context.deployment;
    let model = context.model;
    let tracker = context.tracker;
    const options = utils.buildDeployerOptions(env, model);
    options.params = {
      deployment,
    };
    let flk = ['soajs-kibana', `soajs-logstash`, `${env.environment.toLowerCase()}-filebeat`, 'soajs-metricbeat'];
    
    //if kubernetes no need
    if (env.deployer.selected.indexOf("container.kubernetes") !== -1) {
      flk = ["kibana", "logstash", env.environment.toLowerCase() + '-' + "filebeat"];
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
          tracker[env.environment.toLowerCase()].counterAvailability++;
          if (tracker[env.environment.toLowerCase()].counterAvailability > 150) {
            soajs.log.error(failed.join(" , ") + "were/was not deployed... exiting");
            return cb(new Error(failed.join(" , ") + "were/was not deployed... exiting"));
          }
          else {
            setTimeout(() => {
              return lib.checkAvailability(context, cb);
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
    let env = opts.envRecord;
    let esClient = opts.esClient;
    let model = opts.model;
    let tracker = opts.tracker;
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
    let kibanaPort = "5601";
    let externalKibana = "32601";
    function getKibanaUrl(cb) {
      let url;
      if (deployment && deployment.external) {
        url = `http://${process.env.CONTAINER_HOST}:${externalKibana}/status`;
        return cb(null, url);
      }
      
      const options = utils.buildDeployerOptions(env, model);
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
          console.log("error", error);
          setTimeout(() => {
            if (counter > 150) { // wait 5 min
              cb(error);
            }
            counter++;
            kibanaStatus(cb);
          }, 3000);
        } else {
          counter = 0;
          return cb(error, true);
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
        kibanaStatus((err) => {
          if (err) {
            return cb(err);
          }
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
                  result.env[env.environment.toLowerCase()] = true;
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
