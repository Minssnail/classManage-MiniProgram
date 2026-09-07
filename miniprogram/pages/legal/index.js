const legal = require('../../utils/legal');

Page({
  data: {
    doc: null,
  },

  onLoad(options) {
    const doc = legal.getDocument(options.type);
    wx.setNavigationBarTitle({ title: doc.title });
    this.setData({ doc });
  },
});
