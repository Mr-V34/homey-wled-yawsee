'use strict';

const Homey = require('homey');

class WledSlideApp extends Homey.App {

  async onInit() {
    this.log('WLED Slide Effect app started');
    this.log(`Platform : ${this.homey.platform}`);
    this.log(`Homey ver: ${this.homey.version}`);
  }

  async onUninit() {
    this.log('WLED Slide Effect app stopped');
  }

}

module.exports = WledSlideApp;
