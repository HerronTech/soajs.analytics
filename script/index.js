/* jshint esversion: 6 */
'use strict';
const soajs = require('soajs');
const async = require('async');
const step = require('../functions/initialize.js');
const deactivate = require('../functions/deactivate.js');
const utils = require('../utils/utils');
const collection = {
  analytics: 'analytics',
};
const elasticConfig = require('../data/services/elk/elastic.js');
let tracker = {};
const script = {
  checkAnalytics(opts, cb) {
    const settings = opts.settings;
    const env = opts.env;
    const date = new Date().getTime();
    const data = {};
    // return tracker ready
    let activated = false;
    if (settings) {
      if (settings.env) {
        activated = utils.getActivatedEnv(settings, env);
      }
      data.elasticsearch = settings.elasticsearch ? settings.elasticsearch : {};
      data.kibana = settings.kibana ? settings.kibana : {};
      if (settings.env && settings.env[env]) {
        if (!(tracker[env] && tracker[env].info && tracker[env].info.status)) {
          tracker[env] = {
            info: {
              status: 'ready',
              ts: date,
            }
          };
          data[env] = true;
          data.tracker = tracker[env];
          data.activated = activated;
        } else {
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
    }
    else {
      data.tracker = tracker[env] || {};
      data[env] = false;
      data.activated = activated;
      data.elasticsearch = {};
      data.kibana = {};
    }
    if (data.elasticsearch.security){
      delete data.elasticsearch.security;
    }
    return cb(null, data);
  },
  
  initialize(opts, cb) {
    const data = {};
    const date = new Date().getTime();
    const mode = opts.mode;
    //const env opts.soajs.registry.environment.toLowerCase(= );
    const env = opts.envCode;
    if (mode === 'dashboard' && opts.analyticsSettings
      && opts.analyticsSettings.env && opts.analyticsSettings.env[env]) {
      tracker[env] = {
        info: {
          status: 'ready',
          ts: date,
        },
      };
      data[env] = true;
      data.tracker = tracker[env];
      return cb(null, data);
    }
    
    else if (mode === 'dashboard' && tracker[env]
      && tracker[env].info && tracker[env].info.status
      && tracker[env].info.status === 'started') {
      data.tracker = tracker[env] || {};
      data[env] = false;
      return cb(null, data);
    }
    
    tracker[env] = {
      info: {
        status: 'started',
        ts: date
      }
    };
    
    function returnTracker() {
      if (mode === 'dashboard') {
        tracker[env] = {
          info: {
            status: 'started',
            ts: date,
          },
        };
        data.tracker = tracker[env];
        data[env] = false;
        return cb(null, data);
      }
    }
    
    returnTracker();
    const workFlowMethods = ["insertMongoData", "deployElastic", "pingElasticsearch", "getElasticClientNode",
      "setMapping", "addVisualizations", "deployKibana", "deployLogstash", "deployLogstash", "deployFilebeat",
      "deployMetricbeat", "checkAvailability", "setDefaultIndex"];
    let operations = [];
    utils.setEsCluster(opts, (errC) => {
      if (errC) {
        tracker[env] = {
          "info": {
            "status": "failed",
            "date": new Date().getTime()
          }
        };
        return cb(errC);
      }
      tracker[env].counterPing = 0;
      tracker[env].counterInfo = 0;
      tracker[env].counterAvailability = 0;
      tracker[env].counterKibana = 0;
      opts.tracker = tracker;
      if (mode === 'dashboard') {
        opts.esClient = new soajs.es(opts.esDbInfo.esCluster);
      }
      else {
        if (mode === 'installer') {
          let cluster = JSON.parse(JSON.stringify(opts.esDbInfo.esCluster));
          if (Object.hasOwnProperty.call(opts.analyticsSettings.elasticsearch, 'external')
            && !opts.analyticsSettings.elasticsearch.external) {
            cluster.servers[0].port = elasticConfig.deployConfig.ports[0].published;
          }
          opts.esClient = new soajs.es(cluster);
        }
      }
      
      async.eachSeries(workFlowMethods, (methodName, cb) => {
        operations.push(async.apply(step[methodName], opts));
        return cb();
      }, () => {
        async.series(operations, (err) => {
          opts.esClient.close();
          if (err) {
            console.log("err: ", err)
            tracker[env] = {
              "info": {
                "status": "failed",
                "date": new Date().getTime()
              }
            };
            tracker = opts.tracker;
            if (mode === 'installer') {
              return cb(err);
            }
          }
          else {
            utils.printProgress(soajs, "Analytics deployed");
            if (mode === 'installer') {
              return cb(null, true);
            }
          }
        
          
          //todo check if this is needed
          // else {
          //   script.deactivateAnalytics(opts.soajs, opts.env, opts.model, function (err) {
          //     if (err) {
          //       opts.soajs.log.error(err);
          //     }
          //   });
          // }
         
          
        });
      });
      // async.auto(operations, (err, auto) => {
      //   if (err) {
      //
      //   }
      //   //todo check if this is needed
      //   else {
      //     script.deactivateAnalytics(opts.soajs, opts.env, opts.model, function (err) {
      //       if (err) {
      //         opts.soajs.log.error(err);
      //       }
      //     });
      //   }
      //   // close es connection
      //   if (opts.soajs.inputmaskData && opts.soajs.inputmaskData.elasticsearch === 'local') {
      //     auto.pingElasticsearch.close();
      //   }
      //   else {
      //     opts.esClient.close();
      //   }
      //   if (mode === 'dashboard') {
      //     opts.soajs.log.debug("Analytics deployed");
      //   }
      //   if (mode === 'installer') {
      //     return cb(null, true);
      //   }
      //   return null;
      // });
    });
  },
  
  deactivate(opts, cb) {
    const soajs = opts.soajs;
    const env = opts.soajs.registry;
    const envCode = opts.soajs.inputmaskData.env.toLowerCase();
    const model = opts.model;
    const combo = {};
    combo.collection = collection.analytics;
    combo.conditions = {
      _type: 'settings',
    };
    model.findEntry(soajs, combo, (err, settings) => {
      if (err) {
        return cb(err);
      }
      const options = utils.buildDeployerOptions(env, envCode, model);
      const activated = utils.getActivatedEnv(settings, envCode);
      deactivate.deleteService(options, envCode, activated, (error) => {
        if (error) {
          return cb(error);
        }
        if (!settings) {
          tracker = {};
          return cb(null, true);
        }
        
        if (settings.env && settings.env[envCode]) {
          settings.env[envCode] = false;
        }
        
        if (settings.logstash && settings.logstash[envCode]) {
          delete settings.logstash[envCode];
        }
        
        if (settings.filebeat && settings.filebeat[envCode]) {
          delete settings.filebeat[envCode];
        }
        
        if (settings.metricbeat && !activated) {
          delete settings.metricbeat;
        }
        if (settings.kibana && !activated) {
          delete settings.kibana;
        }
        
        // save
        const comboS = {};
        comboS.collection = collection.analytics;
        comboS.record = settings;
        model.saveEntry(soajs, comboS, (error) => {
          if (error) {
            return cb(error);
          }
          tracker = {};
          return cb(null, true);
        });
      });
    });
  }
  
};

module.exports = script;
