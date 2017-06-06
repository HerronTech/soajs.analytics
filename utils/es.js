/* jshint esversion: 6 */
'use strict';

const elastic = {
  /**
   * do es bulk operations
   * @param {object} esClient:elasticsearch connector object
   * @param {object} array: array of data
   * @param {function} cb: callback function
   */
  esBulk(esClient, array, cb) {
    esClient.bulk(array, cb);
  },
  
};

module.exports = elastic;
