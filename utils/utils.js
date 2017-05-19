/* jshint esversion: 6 */
'use strict';

const utils = {
	buildDeployerOptions: function (envRecord, soajs, model) {
		let options = {};
		let envDeployer = envRecord.deployer;
		
		if (!envDeployer) return null;
		if (Object.keys(envDeployer).length === 0) return null;
		if (!envDeployer.type || !envDeployer.selected) return null;
		if (envDeployer.type === 'manual') return null;
		
		let selected = envDeployer.selected.split('.');
		
		options.strategy = selected[1];
		options.driver = selected[1] + '.' + selected[2];
		options.env = envRecord.code.toLowerCase();
		
		for (let i = 0; i < selected.length; i++) {
			envDeployer = envDeployer[selected[i]];
		}
		
		options.deployerConfig = envDeployer;
		options.soajs = { registry: soajs.registry };
		options.model = model;
		
		//switch strategy name to follow drivers convention
		if (options.strategy === 'docker') options.strategy = 'swarm';
		
		return options;
	}
};

module.exports = utils;