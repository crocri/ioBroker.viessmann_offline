/**********************
 *                    *
 * viessmann adapter  *
 *                    *
 **********************/

/* jshint -W097 */// jshint strict:false
/*jslint node: true */
'use strict';

// you have to require the utils module and call adapter function
const utils = require('@iobroker/adapter-core');
const net = require('net');
const xml2js = require('xml2js');
const fs = require('fs');
const ssh = require('ssh2');
//Hilfsobjekt zum abfragen der Werte
const datapoints = {};
let toPoll = {};
//Zähler für Hilfsobjekt
let step = -1;
//Hilfsarray zum setzen von Werten
let setcommands = [];
//Hilfsvariable zum sammeln mehrere Ergebnisse von write(get1\nget2\nget3\n)
let data_res = '';
//helpers for timeout
let timerWait = null;
let timerErr = null;
let timerReconnect = null;

let client = null;
const parser = new xml2js.Parser();

/**
 * The adapter instance
 * @type {ioBroker.Adapter}
 */
let adapter;

/**
 * Starts the adapter instance
 * @param {Partial<ioBroker.AdapterOptions>} [options]
 */
function startAdapter(options) {
    // Create the adapter and define its methods
    return adapter = utils.adapter(Object.assign({}, options, {
        name: 'viessmann',

        // The ready callback is called when databases are connected and adapter received configuration.
        // start here!
        ready: start, // Main method defined below for readability

        // is called when adapter shuts down - callback has to be called under any circumstances!
        unload: (callback) => {
            try {
                clearTimeout(timerWait);
                clearTimeout(timerErr);
				clearTimeout(timerReconnect);
                adapter.log.info('cleaned everything up...');
                callback();
            } catch (e) {
                callback();
            }
        },

        // is called if a subscribed object changes
        objectChange: (id, obj) => {
            if (obj) {
                // The object was changed
                adapter.log.debug(`object ${id} changed: ${JSON.stringify(obj)}`);
            } else {
                // The object was deleted
                adapter.log.debug(`object ${id} deleted`);
            }
        },

        // is called if a subscribed state changes
        stateChange: (id, state) => {
            if (state) {
                // The state was changed
                if(id === adapter.namespace + '.input.force_polling_interval'){
                    adapter.log.info(`Force polling interval: ${state.val}`);
                    force(state.val);
                }else{
                    adapter.log.info(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
                    setcommands.push(String('set' + id.substring(16, id.length) + ' ' + state.val));
					stepPolling();
                }
            } else {
                // The state was deleted
                adapter.log.info(`state ${id} deleted`);
            }
        },
    }));
}





// is called when databases are connected and adapter received configuration.
// start here!
function start(){

    if(!adapter.config.datapoints.gets)readxml();
    else if(adapter.config.new_read){
        adapter.getForeignObject('system.adapter.' + adapter.namespace, (err, obj)=>{
            if(err){
                adapter.log.error(err);
                return;
            }else{
                obj.native.datapoints = {};
                adapter.setForeignObject('system.adapter.' + adapter.namespace, obj, (err)=>{
                    if(err){
                        adapter.log.error(err);
                        return;
                    }
                    readxml();
                });
            }

        });
    } else {
		adapter.setState('info.connection', true, true);
		// client = new net.Socket();
		setAllObjects(()=> {});
		commands();
		// stepPolling();
		main();
	}
}

//######################################### IMPORT XML FILE #########################################//


function readxml(){
    adapter.log.debug('try to read xml files');
    if(adapter.config.ip === '127.0.0.1'){
        vcontrold_read(adapter.config.path + '/vcontrold.xml');
    }else{
	    //Create a SSH connection
	  const ssh_session = new ssh();
	  adapter.log.debug('try to create a ssh session');
	  ssh_session.connect({
            host: adapter.config.ip,
            username: adapter.config.user_name,
            password: adapter.config.password
        });

        ssh_session.on('ready',()=>{
            adapter.log.debug('FTP session ready');
            ssh_session.sftp ((err, sftp)=>{
                if(err){
                    adapter.log.warn('cannot create a SFTP session ' + err);
                    ssh_session.end();
                }
                else{
                    const moveVcontroldFrom =  adapter.config.path + '/vcontrold.xml';
                    const moveVcontroldTo = __dirname + '/vcontrold.xml';
                    const moveVitoFrom =  adapter.config.path + '/vito.xml';
                    const moveVitoTo = __dirname + '/vito.xml';
                    adapter.log.debug('Try to read Vito from: ' + moveVitoFrom + ' to: ' + __dirname);

                    sftp.fastGet(moveVitoFrom, moveVitoTo , {},(err)=>{
                        if(err){
                            adapter.log.warn('cannot read vito.xml from Server: ' + err);
                            ssh_session.end();
                        }
                        adapter.log.debug('Copy vito.xml from server to host successfully');
                        sftp.fastGet(moveVcontroldFrom, moveVcontroldTo , {},(err)=>{
                            if(err){
                                adapter.log.warn('cannot read vcontrold.xml from Server: ' + err);
                                vcontrold_read(moveVcontroldTo);
                                ssh_session.end();
                            }
                            adapter.log.debug('Copy vcontrold.xml from server to host successfully');
                            vcontrold_read(moveVcontroldTo);
                        });
                    });
                }
            });
        });

        ssh_session.on('close',()=>{
            adapter.log.debug('SSH connection closed');
        });

        ssh_session.on('error',(err)=>{
            adapter.log.warn('check your SSH login dates ' + err);
        });
    }
}


function vcontrold_read(path, callback){
    fs.readFile(path, 'utf8', (err, data) => {
        if(err){
            adapter.log.warn('cannot read vcontrold.xml ' + err);
            vito_read();
        }
        else{
            parser.parseString(data, (err, result)=> {
                if(err){
                    adapter.log.warn('cannot parse vcontrold.xml --> cannot use units  ' + err);
                    vito_read();
                }
                else{
                    let temp;
                    try{
                        temp = JSON.stringify(result);
                        temp = JSON.parse(temp);
                    }
                    catch(e){
                        adapter.log.warn('check vcontrold.xml structure:  ' + e);
                        vito_read();
                        return;
                    }
                    const units = {};
                    const types = {};
                    for(const i in temp['V-Control'].units[0].unit){
                        try{
                            for (const e in temp['V-Control'].units[0].unit[i].entity){
                                const obj = new Object;
                                obj.unit = temp['V-Control'].units[0].unit[i].entity[0];
                                units[temp['V-Control'].units[0].unit[i].abbrev[0]] = obj;
                            }}catch(e){
                            adapter.log.warn('check vcontrold.xml structure cannot read units:  ' + e);
                        }
                        try{
                            for (const e in temp['V-Control'].units[0].unit[i].type){
                                const obj = new Object;
                                obj.type = temp['V-Control'].units[0].unit[i].type[0];
                                types[temp['V-Control'].units[0].unit[i].abbrev[0]] = obj;
                            }
                        }catch(e){
                            adapter.log.warn('check vcontrold.xml structure cannot read types:  ' + e);
                        }
                    }
                    adapter.log.debug('Types in vcontrold.xml: ' + JSON.stringify(types));
                    adapter.log.debug('Units in vcontrold.xml: ' + JSON.stringify(units));
                    adapter.log.info('read vcontrold.xml successfull');
                    vito_read(units, types);
                }
            });
        }
    });
}

function vito_read(units, types){
    const path_ssh = __dirname + '/vito.xml';
    const path_host = adapter.config.path + '/vito.xml';
    let path = '';

    if(adapter.config.ip === '127.0.0.1'){
        path = path_host;
    }else{
        path = path_ssh;
    }
    fs.readFile(path, 'utf8', (err, data) => {
        if(err){
            adapter.log.warn('cannot read vito.xml ' + err);
        }
        else{
            parser.parseString(data, (err, result)=> {
                if(err){
                    adapter.log.warn('cannot parse vito.xml ' + err);
                }
                else{
                    try{
                        let temp = JSON.stringify(result);
                        temp = JSON.parse(temp);
                        adapter.extendForeignObject('system.adapter.' + adapter.namespace, {native: {datapoints: getImport(temp, units, types), new_read: false}});
                        adapter.log.info('read vito.xml successfull');
                        main();
                    }
                    catch(e){
                        adapter.log.warn('check vito.xml structure ' + e);
                    }
                }
            });
        }
    });
}

//######################################### IMPORT STATES #########################################//

function getImport(json, units, types) {
    datapoints['gets'] = {};
    datapoints['sets'] = {};
    datapoints['system'] = {};
    if (typeof json.vito.commands[0].command === 'object') {
        datapoints.system['-ID'] = json.vito.devices[0].device[0].$.ID;
        datapoints.system['-name'] = json.vito.devices[0].device[0].$.name;
        datapoints.system['-protocol'] = json.vito.devices[0].device[0].$.protocol;

        for (const i in json.vito.commands[0].command) {
            const poll = -1;
            const get_command = (json.vito.commands[0].command[i].$.name);
            const desc = (json.vito.commands[0].command[i].description[0]);
            if (get_command.substring(0, 3) === 'get' && get_command.length > 3) {
				if (datapoints.gets[get_command.substring(3, get_command.length).replace(/_f$/,'')]) {
					if (get_command.substr(-2) == '_f')
						datapoints.gets[get_command.substring(3, get_command.length).replace(/_f$/,'')].fast = true;
					continue;
				} else {
					const obj_get = new Object();
					obj_get.fast = (get_command.substr(-2) == '_f');
					obj_get.name = get_command.substring(3, get_command.length).replace(/_f$/,'');
					try{
						obj_get.unit = units[json.vito.commands[0].command[i].unit[0]].unit;
					}catch(e){
						obj_get.unit = '';
					}
					try{
						obj_get.type = get_type(types[json.vito.commands[0].command[i].unit[0]].type);
					}catch(e){
						obj_get.type = 'mixed';
					}
					obj_get.description = desc;
					obj_get.polling = poll;
					obj_get.command = get_command;
					datapoints.gets[get_command.substring(3, get_command.length).replace(/_f$/,'')] = obj_get;
					continue;
				}
            }
            if(get_command.substring(0, 3) === 'set' && get_command.length > 3 && get_command.substr(-2) != '_f') {
                const obj_set = new Object();
                obj_set.name = get_command.substring(3, get_command.length);
                obj_set.description = desc;
                obj_set.polling = 'nicht möglich';
                obj_set.type = 'mixed';
                obj_set.command = get_command;
                datapoints.sets[get_command.substring(3, get_command.length)] = obj_set;
                continue;
            }
        }
        return datapoints;
    }
}

//######################################### GET TYPES #########################################//

function get_type(type){

    switch (type){
        case 'enum':
            return 'number';
            break;
        case 'systime':
            return 'string';
            break;
        case 'systimeshort':
            return 'string';
            break;
        case 'cycletime':
            return 'string';
            break;
        case 'errstate':
            return 'string';
            break;
        case 'char':
            return 'number';
            break;
        case 'uchar':
            return 'number';
            break;
        case 'int':
            return 'number';
            break;
        case 'uint':
            return 'number';
            break;
        case 'short':
            return 'number';
            break;
        case 'ushort':
            return 'number';
            break;
        default:
            return 'mixed';
    }
}

//######################################### SET STATES #########################################//

function addState(pfad, name, unit, beschreibung, type, write, callback) {
    adapter.setObjectNotExists(pfad + name, {
        'type': 'state',
        'common': {
            'name': name,
            'unit': unit,
            'type': type,
            'desc': beschreibung,
            'read': true,
            'write': write
        },
        'native': {}
    }, callback);
}

//######################################### CONFIG STATES #########################################//

function setAllObjects(callback) {
    adapter.getStatesOf((err, _states)=> {

        const configToDelete = [];
        const configToAdd    = [];
        let id;
        const pfadget = 'get.';
        const pfadset = 'set.';
        let count = 0;

        if (adapter.config.datapoints) {
            if(adapter.config.states_only){
                for (const i in  adapter.config.datapoints.gets) {
                    if (adapter.config.datapoints.gets[i].polling !== -1 && adapter.config.datapoints.gets[i].polling != '-1'){
                        configToAdd.push(adapter.config.datapoints.gets[i].name);
                    }
                }
            }else{
                for (const i in  adapter.config.datapoints.gets) {
                    configToAdd.push(adapter.config.datapoints.gets[i].name);
                }
            }
            for (const i in adapter.config.datapoints.sets) {
                configToAdd.push(adapter.config.datapoints.sets[i].name);
            }
        }

        if (_states) {
            for (let i = 0; i < _states.length; i++) {
                const name = _states[i].common.name;
                if (name === 'connection' || name === 'lastPoll' || name === 'timeout_connection' || name === 'Force polling interval') {
                    continue;
                }
                const clean = _states[i]._id;

                if (name.length < 1) {
                    adapter.log.warn('No states found for ' + JSON.stringify(_states[i]));
                    continue;
                }
                id = name.replace(/[.\s]+/g, '_');
                const pos = configToAdd.indexOf(name);
                if (pos !== -1) {
                    configToAdd.splice(pos, 1);
                } else {
                    configToDelete.push(clean);
                }
            }
        }

        if (configToAdd.length) {
            for (const i in adapter.config.datapoints.gets) {
                if (configToAdd.indexOf(adapter.config.datapoints.gets[i].name) !== -1) {
                    count++;
                    addState(pfadget, adapter.config.datapoints.gets[i].name, adapter.config.datapoints.gets[i].unit, adapter.config.datapoints.gets[i].description, adapter.config.datapoints.gets[i].type, false, ()=> {
                        if (!--count && callback) callback();
                    });
                }
            }
            for (const i in adapter.config.datapoints.sets) {
                if (configToAdd.indexOf(adapter.config.datapoints.sets[i].name) !== -1) {
                    count++;
                    addState(pfadset, adapter.config.datapoints.sets[i].name, '', adapter.config.datapoints.sets[i].description, adapter.config.datapoints.sets[i].type, true, ()=> {
                        if (!--count && callback) callback();
                    });
                }
            }
        }
        if (configToDelete.length) {
            for (let e = 0; e < configToDelete.length; e++) {
                adapter.log.debug('States to delete: ' + configToDelete[e]);
                adapter.delObject(configToDelete[e]);
            }
        }
        if (!count && callback) callback();
    });
}

//######################################### POLLING #########################################//

function stepPolling() {
   clearTimeout(timerWait);
   step = -1;
   let actualMinWaitTime = 3600000 * 24;	// one day
   const time = Date.now();
	const ip = adapter.config.ip;
	const port = adapter.config.port || 3002;

   adapter.log.debug('..in Polling');

	// SET data
    if (setcommands.length > 0) {
        const cmd = setcommands.shift();
        adapter.log.debug('Set command: ' + cmd);
        client.connect(port, ip, ()=> {
			data_res = ''
			client.write(cmd + '\n');
			client.end('quit\n');
        });
		return;
    }

	// GET data
    for (const i in toPoll) {
        if (typeof toPoll[i].lastPoll === 'undefined') {
            toPoll[i].lastPoll = time;
        }

        const nextRun = toPoll[i].lastPoll + (toPoll[i].polling * 1000);
        const nextDiff = nextRun - time;

        if (time < nextRun) {
            if (actualMinWaitTime > nextDiff) {
                actualMinWaitTime = nextDiff;
            }
            continue;
        }

        if(nextDiff < actualMinWaitTime) {
            actualMinWaitTime = nextDiff;
            step = i;
        }
    }

    if(step == Object.keys(toPoll)[Object.keys(toPoll).length - 1] || step === -1)
        adapter.setState('info.lastPoll', Math.floor(time/1000), true, true);

    if (step === -1) {
        adapter.log.debug('Wait for next run: ' + actualMinWaitTime + ' in ms');
        timerWait = setTimeout(()=> {
            stepPolling();
        }, actualMinWaitTime);
    } else {
		adapter.log.debug('Client state: ' + client.readyState);
		if (client.readyState === 'readOnly') {
			setTimeout(()=> {
				adapter.log.debug('Have to wait 50 ms to close socket...');
				stepPolling();
			}, 50);
		} else {
//			adapter.log.debug('Next poll: ' + toPoll[step].command.replace(/\n/g, ', ').replace(/_f/g,'') + ' (For Object: ' + step + ')');
			adapter.log.debug('Next poll: ' + toPoll[step].command.replace(/\n/g, ', ') + ' (For Object: ' + step + ')');
			toPoll[step].lastPoll = Date.now();
			client.connect(port, ip, ()=> {
				data_res = ''
				client.write(toPoll[step].command + '\n');
				client.end('quit\n');
			});
		}
    }
}

//######################################### CONFIGURE POLLING COMMANDS #########################################//

function commands() {
	let j = -1;
	let found = [];

	for (const i in adapter.config.datapoints.gets) {
		const polling = adapter.config.datapoints.gets[i].polling;
		if (polling > -1) {
			const command = adapter.config.datapoints.gets[i].command;
			const name = adapter.config.datapoints.gets[i].name;
			const fast = adapter.config.datapoints.gets[i].fast;
			j = found.indexOf(polling);
			if (j === -1) {
				adapter.log.debug('New command for polling(' + polling + '): ' + command);
				found.push(polling);
				j = found.length - 1;
				let obj = new Object();
				obj.name = name;
				obj.command = command;
				obj.polling = polling;
				obj.lastpoll = 0;
				toPoll[j] = obj;
			} else {
				adapter.log.debug('Add command for polling(' + found[j] + '): ' + command);
				toPoll[j].name += '\n' + name;
				toPoll[j].command += '\n' + command + ((fast === undefined || fast) ? '_f' : '');
			}
		}
	}
}

//######################################### CUT ANSWER #########################################//

function split_unit(v) {
    // test if string starts with non digits, then just pass it
    if  (typeof v === 'string' && v !== '' && (/^\D.*$/.test(v)) && !(/^-?/.test(v))){
        return v;
    }
    // else split value and unit
    else if (typeof v === 'string' && v !== ''){
        const split = v.match(/^([-.\d]+(?:\.\d+)?)(.*)$/);
		  if(isDate(split[1])) return v;
        return split[1].trim();
    }
    // catch the rest
    else {
        return v;
    }
}

function isDate(val) {
    const d = new Date(val);
    return !isNaN(d.valueOf());
}

function roundNumber(num, scale) {
    const number = Math.round(num * Math.pow(10, scale)) / Math.pow(10, scale);
    if (num - number > 0) {
        return (number + Math.floor(2 * Math.round((num - number) * Math.pow(10, (scale + 1))) / 10) / Math.pow(10, scale));
    }
    else {
        return number;
    }
}

//######################################### MAIN #########################################//

function main() {

    // The adapters config (in the instance object everything under the attribute "native") is accessible via
    // adapter.config:
	const answer = adapter.config.answer;
    const time_reconnect = adapter.config.reconnect;
    const time_out = 120000;
    let err_count = 0;
    let time_reconnect_type = Number(time_reconnect);
    time_reconnect_type = typeof time_reconnect_type;


    clearTimeout(timerErr);
	clearTimeout(timerReconnect);

	client = null;
    client = new net.Socket();
	stepPolling();

	adapter.log.debug("Main start...");

    client.on('close', ()=> {
        adapter.log.debug('Connection with Viessmann system disconnected!');
    });

    client.on('ready', ()=> {
        adapter.log.debug('Connect with Viessmann sytem!');
		adapter.setState('info.connection', true, true);
    });

	client.on('data', (data)=> {
		data = String(data);
		const ok = /^OK/;
		const nok = /NOT OK/;
		const fail = /ERR/;
		const vctrld = /vctrld>/;

		adapter.log.debug('RAW Data: ' + data);
		// let data_lines = data.replace(/\n$/,'').split(/(vctrld>)(?!$)/).filter(Boolean)
		// let data_lines = data.replace(/\n$/,'').replace(/^vctrld>/,'vctrld>\n').replace(/\ vctrld>$/,'\nvctrld>').replace(/\ vctrld>/g,'\nvctrld>\n').split('\n').filter(Boolean)
		// let data_lines = data.replace(/vctrld>/g,'\n').replace(/\n$/g,'').split('\n').filter(Boolean)
		let data_lines = data.replace(/vctrld>/g,'\n').replace(/\n$/g,'').replace(/\n([0-9]):/g,' $1:').split('\n').filter(Boolean)

		data_lines.forEach( (data) => {
			// data = data.replace(/\n$/,'').replace(/\n/g,',').trim()
			data = data.trim()

			adapter.log.debug('RAW Data after replace: ' + data);

			if (ok.test(data)) {
				adapter.log.debug('Send command okay!');
			} else if(fail.test(data) || nok.test(data)) {
				// Restart if too many errors and config "errors" is set to true
				adapter.log.warn('Vctrld send ERROR: ' + data);
				err_count++;
				if(err_count > 5 && adapter.config.errors){
					adapter.setState('info.connection', false, true);
					adapter.log.warn('Vctrld send too many errors...');
					client.end();
					client.destroy(); // kill client after server's response
					clearTimeout(timerWait);
					timerErr = setTimeout(main, 10000);
				}else{
					// if (data_res != '')
					stepPolling();
				}
			} else if(data == 'good bye!') {
				if (data_res != '') {
					adapter.log.debug('Write Get: ' + data_res.replace(/\n$/, '').split('\n'));
					const val = data_res.replace(/\n$/, '').split('\n');
					const name = toPoll[step].name.split('\n');
					adapter.log.debug('Write Get length: ' + val.length + ',' + name.length);
					if (val.length === name.length) {
						for (let i = 0; i < val.length; i++) {
							adapter.log.debug('Set state: name=' + name[i] + ', val=' + val[i]);
							adapter.getObject('get.' + name[i], function (err, obj) {
								if (err)
									adapter.log.error(err)
								else {
									adapter.log.debug("type = " + obj.common.type);
									adapter.setState('get.' + name[i], obj.common.type === "number" ? Number(val[i]) : val[i], true, (err)=> {
										if (err) adapter.log.error(err);
									});
								}
							});
						}
					}
				}
				stepPolling();
				return;
			// } else if(data == 'vctrld>') {
			//	return
			} else if(step == -1 || step == '') {
				return;
			} else {
				// if (vctrld.test(data)) {
				//	 data = data.substring(0, data.length - 7);
				// }
				try {
					if(answer){
						data = split_unit(data);
						if(!isNaN(data)) {data = roundNumber(parseFloat(data), 2);}
						data_res += data + '\n'
					}
					else{
						data_res += data + '\n'
					}
				} catch(e) {
					data_res += data + '\n'
				}
				err_count = 0;
			}
		})
    });

    client.on('error', (e)=> {
		adapter.setState('info.connection', false, true);
        adapter.log.error('Connection error--> ' + e);
		client.end();
		client.destroy(); // kill client after server's response
		if(timerReconnect){clearTimeout(timerReconnect);}
        if(time_reconnect != '' && time_reconnect_type == 'number'){
            adapter.log.error('Wait ' + time_reconnect + ' minute(s) for restart')
			timerReconnect = setTimeout(main, time_reconnect*60000);
        }else {
            adapter.log.warn('Reconnect time is not set, exit program');
        }
    });

    client.on('timeout', ()=> {
		adapter.setState('info.connection', false, true);
        adapter.log.error('Timeout connection error!');
		client.end();
		client.destroy(); // kill client after server's response
		clearTimeout(timerWait);
		if(timerTimeout){clearTimeout(timerTimeout);}

        if(time_reconnect != '' && time_reconnect_type == 'number'){
			adapter.log.error('Wait ' + time_reconnect + ' minute(s) for restart')
            timerReconnect = setTimeout(main, time_reconnect*60000);
        }else {
            adapter.log.warn('Reconnect time is not set, exit program');
        }
    });

    // in this viessmann all states changes inside the adapters namespace are subscribed
    adapter.subscribeStates('set.*');
    adapter.subscribeStates('input.*');

}

//######################################### HELPERS #########################################//

function force(id){
    try{
        const force_step = id.slice(3);
        toPoll[force_step].lastPoll = 0;
    }catch(e){
        adapter.log.warn(`Force polling interval: ${id} not incude in get states`);
    }
}

//###########################################################################################//

// If started as allInOne/compact mode => return function to create instance
if (module && module.parent) {
    module.exports = startAdapter;
} else {
    // or start the instance directly
    startAdapter();
}

