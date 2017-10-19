/* jshint esversion: 6 */
'use strict';

const elastic = {
  /**
   * do es bulk operations
   * @param {object} esClient:elasticsearch connector object
   * @param {object} arrayData: array of data
   * @param {function} cb: callback function
   */
  esBulk(esClient, arrayData, cb) {
    esClient.bulk(arrayData, cb);
  },
  
};

module.exports = elastic;
