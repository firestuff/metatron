navigator.getUserMedia = navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia;
window.AudioContext = window.AudioContext || window.webkitAudioContext || window.mozAudioContext;


var metatron = {};

metatron.FREQS = [
  [ 1209, 1336, 1477, 1633, 2200, ],
  [ 697, 770, 852, 941 ],
];

metatron.POSSIBLE_VALUES = 1;
metatron.FREQS.forEach(function(freqSet) {
  metatron.POSSIBLE_VALUES *= freqSet.length;
});

metatron.MARK_SECONDS = 0.2;

metatron.FFT_SIZE = 2048;
metatron.CYCLE_THRESHOLD = 4;
metatron.CYCLES_PER_MARK = 8;


metatron.checksum = function(str) {
  var checksum = 0;
  for (var i = 0; i < str.length; i++) {
    checksum ^= str.charCodeAt(i);
  }
  return checksum;
};


metatron.Generator = function(tag) {
  this.context_ = new AudioContext();
  this.tag_ = tag;
};


metatron.Generator.prototype.addPair_ = function(index, value) {
  var startOffset = metatron.MARK_SECONDS * index;

  metatron.FREQS.forEach(function(choices) {
    var freq = choices[value % choices.length];
    value = Math.floor(value / choices.length);

    var osc = this.context_.createOscillator();
    osc.frequency.value = freq;
    osc.connect(this.context_.destination);
    osc.start(this.context_.currentTime + startOffset);
    osc.stop(this.context_.currentTime + startOffset + metatron.MARK_SECONDS);
  }.bind(this));
};


metatron.Generator.prototype.playValue_ = function(value) {
  // Make sure we always change values.
  value += 1;
  this.lastValue_ = (this.lastValue_ + value) % metatron.POSSIBLE_VALUES;
  this.addPair_(this.indexOffset_++, this.lastValue_);
};


metatron.Generator.prototype.playRaw_ = function(str) {
  for (var i = 0; i < str.length; i++) {
    var chr = str.charCodeAt(i);
    // Big endian nibbles
    this.playValue_(chr >> 4);
    this.playValue_(chr % 16);
  }
};


metatron.Generator.prototype.play = function(str) {
  this.lastValue_ = 0;
  this.indexOffset_ = 0;
  // Resync the listener to the base value.
  this.playValue_(0);
  this.playRaw_(this.tag_);
  this.playRaw_(String.fromCharCode(str.length));
  this.playRaw_(str);
  this.playRaw_(String.fromCharCode(metatron.checksum(str)));
};


metatron.Listener = function(tag) {
  this.context_ = new AudioContext();
  this.activeValue_ = null;
  this.newValue_ = null;
  this.votes_ = 0;
  this.lastValue_ = 0;
  this.state_ = metatron.Listener.STATE_.WAIT_TAG;

  this.tag_ = [];
  for (var i = 0; i < tag.length; i++) {
    var chr = tag.charCodeAt(i);
    this.tag_.push(chr >> 4);
    this.tag_.push(chr % 16);
  }
  this.tagBuffer_ = [];

  navigator.getUserMedia({
    "audio": {
      "mandatory": {
        "googEchoCancellation": "false",
        "googAutoGainControl": "false",
        "googNoiseSuppression": "false",
         "googHighpassFilter": "false",
      },
    "optional": []
    }
  },
  function(stream) {
    var sampleRate = this.context_.sampleRate;

    this.analyser_ = this.context_.createAnalyser();
    this.analyser_.fftSize = metatron.FFT_SIZE;
    this.analyser_.smoothingTimeConstant = 0.0;

    this.bufSize_ = this.analyser_.frequencyBinCount;
    this.buffer_ = new Uint8Array(this.bufSize_);

    var streamSource = this.context_.createMediaStreamSource(stream);
    streamSource.connect(this.analyser_);
    
    var hzPerBucket = sampleRate / metatron.FFT_SIZE;
    this.fftIndices_ = [];
    metatron.FREQS.forEach(function(freqSet) {
      freqSet.forEach(function(freq) {
        this.fftIndices_.push({
          index: Math.round(freq / hzPerBucket),
          freq: freq,
        });
      }.bind(this));
    }.bind(this));

    var interval = metatron.MARK_SECONDS / metatron.CYCLES_PER_MARK * 1000;
    console.log('Poll interval:', interval, 'ms');
    window.setInterval(this.analyse_.bind(this), interval);
  }.bind(this),
  function(error) {
  }.bind(this));
};


metatron.Listener.STATE_ = {
  WAIT_TAG: 1,
  WAIT_LENGTH: 2,
  WAIT_CONTENTS: 3,
  WAIT_CHECKSUM: 4,
};


metatron.Listener.prototype.currentValue_ = function() {
  this.analyser_.getByteFrequencyData(this.buffer_);
  var values = [];
  this.fftIndices_.forEach(function(index) {
    values.push({
      freq: index.freq,
      value: this.buffer_[index.index],
    });
  }.bind(this));
  values.sort(function(a, b) {
    return b.value - a.value;
  });

  var activeValues = values.slice(0, metatron.FREQS.length);
  var outputValue = 0;
  var error = false;
  activeValues.forEach(function(value) {
    var multiplier = 1, found = 0;
    metatron.FREQS.forEach(function(freqSet) {
      var index = freqSet.indexOf(value.freq);
      if (index >= 0) {
        found++;
        outputValue += index * multiplier;
      }
      multiplier *= freqSet.length;
    }.bind(this));
    if (found != 1) {
      error = true;
      console.log('Wrong number of tones matched:', found, activeValues);
    }
  }.bind(this));

  if (error) {
    return null;
  }

  return outputValue;
};


metatron.Listener.prototype.analyse_ = function() {
  var newValue = this.currentValue_();

  if (newValue === null) {
    return;
  }

  if (newValue === this.activeValue_) {
    this.votes_ = 0;
    this.newValue_ = null;
    return;
  }

  if (newValue === this.newValue_) {
    if (++this.votes_ == metatron.CYCLE_THRESHOLD) {
      this.onValue_(this.newValue_);
      this.activeValue_ = this.newValue_;
      this.newValue_ = null;
      this.votes_ = 0;
    }
    return;
  }

  this.newValue_ = newValue;
  this.votes_ = 1;
};


metatron.Listener.prototype.onValue_ = function(value) {
  var realValue = value;
  if (this.lastValue_ >= realValue) {
    realValue += metatron.POSSIBLE_VALUES;
  }
  realValue = realValue - this.lastValue_ - 1;
  this.lastValue_ = value;

  console.log(realValue);

  switch (this.state_) {
    case metatron.Listener.STATE_.WAIT_TAG:
      this.tagBuffer_.push(realValue);
      if (this.tagBuffer_.length > this.tag_.length) {
        this.tagBuffer_.shift();
      }

      if (this.tag_.equals(this.tagBuffer_)) {
        console.log('tag seen!');
        this.state_ = metatron.Listener.STATE_.WAIT_LENGTH;
        this.lengthBuffer_ = [];
      }
      break;

    case metatron.Listener.STATE_.WAIT_LENGTH:
      this.lengthBuffer_.push(realValue);
      if (this.lengthBuffer_.length == 2) {
        this.length_ = 0;
        this.lengthBuffer_.forEach(function(part) {
          this.length_ <<= 4;
          this.length_ += part;
        }.bind(this));
        this.contentsParts_ = [];
        this.state_ = metatron.Listener.STATE_.WAIT_CONTENTS;
      }
      break;

    case metatron.Listener.STATE_.WAIT_CONTENTS:
      this.contentsParts_.push(realValue);
      if (this.contentsParts_.length == this.length_ * 2) {
        var chrs = [];
        for (i = 0; i < this.contentsParts_.length; i += 2) {
          chrs.push(String.fromCharCode((this.contentsParts_[i] << 4)
                                        + this.contentsParts_[i + 1]));
        }
        this.contents_ = chrs.join('');
        this.checksumParts_ = [];
        this.state_ = metatron.Listener.STATE_.WAIT_CHECKSUM;
      }
      break;

    case metatron.Listener.STATE_.WAIT_CHECKSUM:
      this.checksumParts_.push(realValue);
      if (this.checksumParts_.length == 2) {
        var checksum = 0;
        this.checksumParts_.forEach(function(part) {
          checksum <<= 4;
          checksum += part;
        }.bind(this));
        if (checksum == metatron.checksum(this.contents_)) {
          console.log('checksum match');
          document.getElementById('value').textContent = this.contents_;
        } else {
          console.log('corrupted message');
        }
        this.state_ = metatron.Listener.STATE_.WAIT_TAG;
      }
      break;
  }
};


Array.prototype.equals = function(other) {
  if (this.length != other.length) {
    return false;
  }

  for (var i = 0; i < this.length; i++) {
    if (this[i] != other[i]) {
      return false;
    }
  }

  return true;
};
