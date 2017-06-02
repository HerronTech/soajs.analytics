/* jshint esversion: 6 */
'use strict';
const Mongo = require('soajs').mongo;

let mongo = null;

function checkForMongo(soajs) {
  if (!mongo) {
    mongo = new Mongo(soajs.registry.coreDB.provision);
  }
}
const driver = {
  checkForMongo(soajs) {
    checkForMongo(soajs);
  },

  countEntries(soajs, opts, cb) {
    checkForMongo(soajs);
    mongo.count(opts.collection, opts.conditions || {}, cb);
  },

  findEntries(soajs, opts, cb) {
    checkForMongo(soajs);
    mongo.find(opts.collection, opts.conditions || {}, opts.fields || null, opts.options || null, cb);
  },

  findEntry(soajs, opts, cb) {
    checkForMongo(soajs);
    mongo.findOne(opts.collection, opts.conditions || {}, opts.fields || null, opts.options || null, cb);
  },

  saveEntry(soajs, opts, cb) {
    checkForMongo(soajs);
    mongo.save(opts.collection, opts.record, cb);
  },

  insertEntry(soajs, opts, cb) {
    checkForMongo(soajs);
    mongo.insert(opts.collection, opts.record, opts.versioning || false, cb);
  },

  removeEntry(soajs, opts, cb) {
    checkForMongo(soajs);
    mongo.remove(opts.collection, opts.conditions, cb);
  },

  updateEntry(soajs, opts, cb) {
    checkForMongo(soajs);
    mongo.update(opts.collection, opts.conditions, opts.fields, opts.options || {}, opts.versioning || false, cb);
  },
};

module.exports = driver;
