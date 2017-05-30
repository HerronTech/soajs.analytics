'use strict';

module.exports = {
	elasticsearch: {
		cluster: {
			"servers": [
				{
					"host": "soajs-analytics-elasticsearch",
					"port": 9200
				}
			],
			"credentials": {
				"username": "",
				"password": ""
			},
			"URLParam": {
				"protocol": "http"
			},
			"extraParam": {
				"requestTimeout": 30000,
				"keepAlive": true,
				"maxSockets": 30,
				"number_of_shards": 5,
				"number_of_replicas": 1,
				"apiVersion": "5.x"
			}
		}
	}
};
