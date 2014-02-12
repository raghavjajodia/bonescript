var fs = require('fs');
var winston = require('winston');
var my = require('./my');
var parse = require('./parse');

var debug = true;

var gpioFile = {};
var pwmPrefix = {};
var ainPrefix = "";

exports.logfile = '/var/lib/cloud9/bonescript.log';

exports.readPWMFreqAndValue = function(pin, pwm) {
    var mode = {};
    try {
        var period = fs.readFileSync(pwmPrefix[pin.pwm.name]+'/period');
        var duty = fs.readFileSync(pwmPrefix[pin.pwm.name]+'/duty');
        mode.freq = 1.0e9 / period;
        mode.value = duty / period;
    } catch(ex) {
    }
    return(mode);
};

exports.readGPIODirection = function(n, gpio) {
    var mode = {};
    var directionFile = "/sys/class/gpio/gpio" + n + "/direction";
    if(my.file_existsSync(directionFile)) {
        mode.active = true;
        var direction = fs.readFileSync(directionFile, 'utf-8');
        direction = direction.replace(/^\s+|\s+$/g, '');
        mode.direction = direction;
    }
    return(mode);
};

exports.readPinMux = function(pin, mode, callback) {
    var pinctrlFile = '/sys/kernel/debug/pinctrl/44e10800.pinmux/pins';
    var muxRegOffset = parseInt(pin.muxRegOffset, 16);
    var readPinctrl = function(err, data) {
        if(err) {
            mode.err = 'readPinctrl error: ' + err;
            if(debug) winston.debug(mode.err);
            callback(mode);
        }
        mode = parse.modeFromPinctrl(data, muxRegOffset, 0x44e10800, mode);
        callback(mode);
    };
    var tryPinctrl = function(exists) {
        if(exists) {
            fs.readFile(pinctrlFile, 'utf8', readPinctrl);
        } else {
            if(debug) winston.debug('getPinMode(' + pin.key + '): no valid mux data');
            callback(mode);
        }
    };
    my.file_exists(pinctrlFile, tryPinctrl);
};

exports.setPinMode = function(pin, pinData, template, resp) {
    if(template == 'bspm') {
        gpioFile[pin.key] = '/sys/class/gpio/gpio' + pin.gpio + '/value';
        if(pin.led) {
            gpioFile[pin.key] = '/sys/class/leds/beaglebone::' + pin.led + '/brightness';
        }
    } else if(template == 'bspwm') {
        if(!my.load_dt('am33xx_pwm')) {
            resp.err = 'Error loading am33xx_pwm devicetree overlay';
            return(resp);
        }
    }
    if(!my.create_dt(pin, pinData, template)) {
        resp.err = 'Error loading devicetree overlay for ' + pin.key + ' using template ' + template;
        return(resp);
    }
    if(template == 'bspwm') {
        try {
            var ocp = my.file_find('/sys/devices', 'ocp.');
            var pwm_test = my.file_find(ocp, 'bs_pwm_test_' + pin.key + '.', 10000);
            my.file_find(pwm_test, 'period', 10000);
            pwmPrefix[pin.pwm.name] = pwm_test;
            fs.writeFileSync(pwm_test+'/polarity', 0);
        } catch(ex) {
            resp.err = 'Error enabling PWM controls: ' + ex;
        }
    }
    return(resp);
};

exports.setLEDPinToGPIO = function(pin, resp) {
    var path = "/sys/class/leds/beaglebone:green:" + pin.led + "/trigger";

    if(my.file_existsSync(path)) {
        fs.writeFileSync(path, "gpio");
    } else {
        resp.err = "Unable to find LED " + pin.led;
        winston.error(resp.err);
        resp.value = false;
    }

    return(resp);
};

exports.exportGPIOControls = function(pin, direction, resp, callback) {
    var n = pin.gpio;
    my.file_exists(gpioFile[pin.key], onFileExists);
    
    function onFileExists(exists) {
        if(exists) {
            if(debug) winston.debug("gpio: " + n + " already exported.");
            fs.writeFile("/sys/class/gpio/gpio" + n + "/direction",
                direction, null, onGPIODirectionSet);
        } else {
            if(debug) winston.debug("exporting gpio: " + n);
            fs.writeFile("/sys/class/gpio/export", "" + n, null, onGPIOExport);
        }
    }
 
    function onGPIOExport(err) {
        if(err) onError(err);
        if(debug) winston.debug("setting gpio " + n +
            " direction to " + direction);
        fs.writeFile("/sys/class/gpio/gpio" + n + "/direction",
            direction, null, onGPIODirectionSet);
    }

    function onGPIODirectionSet(err) {
        if(err) onError(err);
        else callback(resp);
    }
    
    function onError(err) {
        resp.err = 'Unable to export gpio-' + n + ': ' + err;
        resp.value = false;
        if(debug) winston.debug(resp.err);
        findOwner();
    }
    
    function findOwner() {
        fs.readFile('/sys/kernel/debug/gpio', 'utf-8', onGPIOUsers);
    }
    
    function onGPIOUsers(err, data) {
        if(!err) {
            var gpioUsers = data.split('\n');
            for(var x in gpioUsers) {
                var y = gpioUsers[x].match(/gpio-(\d+)\s+\((\S+)\s*\)/);
                if(y && y[1] == n) {
                    resp.err += '\nconsumed by ' + y[2];
                    if(debug) winston.debug(resp.err);
                }
            }
        }
        callback(resp);
    }
    
};

exports.writeGPIOValue = function(pin, value, callback) {
    if(typeof gpioFile[pin.key] == 'undefined') {
        gpioFile[pin.key] = '/sys/class/gpio/gpio' + pin.gpio + '/value';
        if(pin.led) {
            gpioFile[pin.key] = "/sys/class/leds/beaglebone:";
            gpioFile[pin.key] += "green:" + pin.led + "/brightness";
        }
        if(!my.file_existsSync(gpioFile[pin.key])) {
            winston.error("Unable to find gpio: " + gpioFile[pin.key]);
        }
    }
    if(debug) winston.debug("gpioFile = " + gpioFile[pin.key]);
    fs.writeFile(gpioFile[pin.key], '' + value, null, callback);
};

exports.readGPIOValue = function(pin, resp, callback) {
    var gpioFile = '/sys/class/gpio/gpio' + pin.gpio + '/value';
    var readFile = function(err, data) {
        if(err) {
            resp.err = 'digitalRead error: ' + err;
            winston.error(resp.err);
        }
        resp.value = parseInt(data, 2);
        callback(resp);
    };
    fs.readFile(gpioFile, readFile);
};

exports.enableAIN = function() {
    var helper = "";
    if(my.load_dt('cape-bone-iio')) {
        var ocp = my.file_find('/sys/devices', 'ocp.', 1000);
        helper = my.file_find(ocp, 'helper.', 10000);
        ainPrefix = helper + '/AIN';
    }
    return(helper.length > 1);
};

exports.readAIN = function(pin, resp, callback) {
    var ainFile = ainPrefix + pin.ain.toString();
    var readFile = function(err, data) {
        if(err) {
            resp.err = 'analogRead error: ' + err;
            winston.error(resp.err);
        }
        resp.value = parseInt(data, 10) / 1800;
        callback(resp);
    };
    fs.readFile(ainFile, readFile);
};

exports.writeGPIOEdge = function(pin, mode) {
    fs.writeFileSync('/sys/class/gpio/gpio' + pin.gpio + '/edge', mode);

    var resp = {};
    resp.gpioFile = '/sys/class/gpio/gpio' + pin.gpio + '/value';
    resp.valuefd = fs.openSync(resp.gpioFile, 'r');
    resp.value = new Buffer(1);

    return(resp);
};

exports.writePWMFreqAndValue = function(pin, pwm, freq, value, resp) {
    var path = pwmPrefix[pin.pwm.name];
    try {
        var period = Math.round( 1.0e9 / freq ); // period in ns
        var duty = Math.round( period * value );
        fs.writeFileSync(path+'/duty', 0);
        if(pwm.freq != freq) {
            fs.writeFileSync(path+'/period', period);
        }
        fs.writeFileSync(path+'/duty', duty);
    } catch(ex) {
        resp.err = 'error updating PWM freq and value: ' + path + ', ' + ex;
        winston.error(resp.err);
    }
    return(resp);
};

exports.readEeproms = function(eeproms) {
    var boardName = fs.readFileSync(my.is_capemgr() + '/baseboard/board-name',
            'ascii');
    var version = fs.readFileSync(my.is_capemgr() + '/baseboard/revision',
            'ascii');
    var serialNumber = fs.readFileSync(my.is_capemgr() + '/baseboard/serial-number',
            'ascii');
    eeproms['/sys/bus/i2c/drivers/at24/1-0050/eeprom'] = {};
    eeproms['/sys/bus/i2c/drivers/at24/1-0050/eeprom'].boardName = boardName;
    eeproms['/sys/bus/i2c/drivers/at24/1-0050/eeprom'].version = version;
    eeproms['/sys/bus/i2c/drivers/at24/1-0050/eeprom'].serialNumber = serialNumber;
    return(eeproms);
};

exports.readPlatform = function(platform) {
    platform.name = fs.readFileSync(my.is_capemgr() + '/baseboard/board-name',
        'ascii').trim();
    if(platform.name == 'A335BONE') platform.name = 'BeagleBone';
    if(platform.name == 'A335BNLT') platform.name = 'BeagleBone Black';
    platform.version = fs.readFileSync(my.is_capemgr() + '/baseboard/revision',
        'ascii').trim();
    if(!platform.version.match(/^[\040-\176]*$/)) delete platform.version;
    platform.serialNumber = fs.readFileSync(my.is_capemgr() +
        '/baseboard/serial-number', 'ascii').trim();
    if(!platform.serialNumber.match(/^[\040-\176]*$/)) delete platform.serialNumber;
    return(platform);
};
