/* eslint no-plusplus: ["error", { "allowForLoopAfterthoughts": true }] */
const details = () => ({
  id: 'Tdarr_Plugin_MC93_Migz5ConvertAudio',
  Stage: 'Pre-processing',
  Name: 'Migz Convert Audio Streams',
  Type: 'Audio',
  Operation: 'Transcode',
  Description: 'This plugin can convert any 2.0 audio track/s to AAC and can create downmixed audio tracks. \n\n',
  Version: '2.7',
  Tags: 'pre-processing,ffmpeg,audio only,configurable',
  Inputs: [{
    name: 'aac_stereo',
    type: 'boolean',
    defaultValue: false,
    inputUI: {
      type: 'dropdown',
      options: [
        'false',
        'true',
      ],
    },
    tooltip: `Specify if any 2.0 audio tracks should be converted to aac for maximum compatability with devices.
                    \\nOptional.
             \\nExample:\\n
             true

             \\nExample:\\n
             false`,
  },
  {
    name: 'ac3_surround',
    type: 'boolean',
    defaultValue: false,
    inputUI: {
      type: 'dropdown',
      options: [
        'false',
        'true',
      ],
    },
    tooltip: `Specify if any surround sound audio tracks should be converted to ac3 for maximum compatability with devices.
                    \\nOptional.
             \\nExample:\\n
             true

             \\nExample:\\n
             false`,
  },
  {
    name: 'downmix',
    type: 'boolean',
    defaultValue: false,
    inputUI: {
      type: 'dropdown',
      options: [
        'false',
        'true',
      ],
    },
    tooltip: `Specify if downmixing should be used to create extra audio tracks.
                    \\nI.e if you have an 8ch but no 2ch or 6ch, create the missing audio tracks from the 8 ch.
                    \\nLikewise if you only have 6ch, create the missing 2ch from it. Optional.
             \\nExample:\\n
             true

             \\nExample:\\n
             false`,
  },
  {
    name: 'downmix_single_track',
    type: 'boolean',
    defaultValue: false,
    inputUI: {
      type: 'dropdown',
      options: [
        'false',
        'true',
      ],
    },
    tooltip: 'By default this plugin will downmix each track. '
    + 'So four 6 channel tracks will result in four 2 channel tracks.'
    + ' Enable this option to only downmix a single track.',
  },
  {
    name: 'preserve_channel_title',
    type: 'boolean',
    defaultValue: false,
    inputUI: {
      type: 'dropdown',
      options: [
        'false',
        'true',
      ],
    },
    tooltip: 'Specify whether downmixed tracks should preserve the original track title.'
      + ' \\nWhen false (default), the plugin keeps the pre-#903 behaviour.'
      + ' \\nDownmixed tracks use only the new channel layout as the title'
      + ' (e.g. "2.0" or "5.1").'
      + ' \\nWhen true, the plugin restores the PR #903 behaviour and appends'
      + ' the new layout to the original title'
      + ' (e.g. "E-AC-3 Atmos 5.1 - 2.0").'
      + ' \\nExample:\\n\nfalse\n\n\\nExample:\\n\ntrue',
  },
  ],
});

// Build a downmix title that appends the new channel layout, but avoids
// appending a layout the source title already ends with (e.g. don't turn
// "Anglais E-AC3 2.0" into "Anglais E-AC3 2.0 - 2.0"). The boundary check
// uses [^0-9.] so any non-digit/non-dot character (whitespace, paren,
// bracket, dash, etc.) terminates the layout cleanly without matching
// substrings of larger numbers like "15.1" or "12.0".
const buildDownmixTitle = (originalTitle, layout) => {
  if (!originalTitle) return layout;
  const escaped = layout.replace(/\./g, '\\.');
  if (new RegExp(`(?:^|[^0-9.])${escaped}$`).test(originalTitle)) {
    return originalTitle;
  }
  return `${originalTitle} - ${layout}`;
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const plugin = (file, librarySettings, inputs, otherArguments) => {
  const lib = require('../methods/lib')();
  // eslint-disable-next-line @typescript-eslint/no-unused-vars,no-param-reassign
  inputs = lib.loadDefaultValues(inputs, details);
  const response = {
    processFile: false,
    container: `.${file.container}`,
    handBrakeMode: false,
    FFmpegMode: true,
    reQueueAfter: true,
    infoLog: '',
  };

  //  Check if both inputs.aac_stereo AND inputs.downmix have been left empty. If they have then exit plugin.
  if (inputs && inputs.aac_stereo === '' && inputs.downmix === '') {
    response.infoLog += '☒Plugin has not been configured, please configure required options. Skipping this plugin. \n';
    response.processFile = false;
    return response;
  }

  // Check if file is a video. If it isn't then exit plugin.
  if (file.fileMedium !== 'video') {
    // eslint-disable-next-line no-console
    console.log('File is not video');
    response.infoLog += '☒File is not video. \n';
    response.processFile = false;
    return response;
  }

  // Set up required variables.
  let ffmpegCommandInsert = '';
  let audioIdx = 0;         // Tracks audio stream index of original audio streams for in-place conversion
  let addedAudioIdx = 0;    // Tracks audio stream index for newly generated audio streams
  let has2Channel = false;
  let has6Channel = false;
  let convert = false;
  let is2channelAdded = false;
  let is6channelAdded = false;

  // Go through each stream in the file.
  for (let i = 0; i < file.ffProbeData.streams.length; i++) {
    try {
      // Go through all audio streams and check if 2,6 & 8 channel tracks exist or not.
      if (file.ffProbeData.streams[i].codec_type.toLowerCase() === 'audio') {
        if (file.ffProbeData.streams[i].channels === 2) {
          has2Channel = true;
        }
        if (file.ffProbeData.streams[i].channels === 6) {
          has6Channel = true;
        }
        addedAudioIdx += 1;
      }
    } catch (err) {
      // Error
    }
  }

  // Go through each stream in the file.
  for (let i = 0; i < file.ffProbeData.streams.length; i++) {
    // Check if stream is audio.
    if (file.ffProbeData.streams[i].codec_type.toLowerCase() === 'audio') {
      // Get original track metadata. Strip characters that would break the ffmpeg
      // command-line quoting (we wrap titles in double quotes below).
      const originalTitle = (file.ffProbeData.streams[i].tags?.title || '').replace(/["`$\\]/g, '');
      const language = (file.ffProbeData.streams[i].tags?.language || '').replace(/["`$\\]/g, '');

      // Catch error here incase user left inputs.downmix empty.
      try {
        if (inputs.downmix === true) {
          // Check if file has 7+ channel audio but no 6 channel, if so then create 6 channel downmix.
          if (
            file.ffProbeData.streams[i].channels > 6
            && has6Channel === false
            && (inputs.downmix_single_track === false
              || (inputs.downmix_single_track === true && is6channelAdded === false))
          ) {
            const newTitle = inputs.preserve_channel_title
              ? buildDownmixTitle(originalTitle, '5.1') : '5.1';
            ffmpegCommandInsert += `-map 0:${i} -c:a:${addedAudioIdx} ac3 -ac:a:${addedAudioIdx} 6 `
              + `-metadata:s:a:${addedAudioIdx} "title=${newTitle}" `;

            // Preserve language if it exists
            if (language) {
              ffmpegCommandInsert += `-metadata:s:a:${addedAudioIdx} "language=${language}" `;
            }

            response.infoLog += `☒Audio track is ${file.ffProbeData.streams[i].channels} channel, no 6 channel exists. `
              + `Creating 6 channel "${newTitle}" from ${file.ffProbeData.streams[i].channels} channel. \n`;
            convert = true;
            is6channelAdded = true;
            addedAudioIdx += 1;
          }
          // Check if file has 2+ channel audio but no 2 channel, if so then create 2 channel downmix.
          if (
            file.ffProbeData.streams[i].channels > 2
            && has2Channel === false
            && (inputs.downmix_single_track === false
              || (inputs.downmix_single_track === true && is2channelAdded === false))
          ) {
            const newTitle = inputs.preserve_channel_title
              ? buildDownmixTitle(originalTitle, '2.0') : '2.0';
            ffmpegCommandInsert += `-map 0:${i} -c:a:${addedAudioIdx} aac -ac:a:${addedAudioIdx} 2 `
              + `-metadata:s:a:${addedAudioIdx} "title=${newTitle}" `;
            // Preserve language if it exists
            if (language) {
              ffmpegCommandInsert += `-metadata:s:a:${addedAudioIdx} "language=${language}" `;
            }
            response.infoLog += `☒Audio track is ${file.ffProbeData.streams[i].channels} channel, no 2 channel exists. `
              + `Creating 2 channel "${newTitle}" from ${file.ffProbeData.streams[i].channels} channel. \n`;
            convert = true;
            is2channelAdded = true;
            addedAudioIdx += 1;
          }
        }
      } catch (err) {
        // Error
      }

      // Catch error here incase user left inputs.downmix empty.
      try {
        if (inputs.aac_stereo === true) {
          if (
            file.ffProbeData.streams[i].codec_name !== 'aac'
            && file.ffProbeData.streams[i].channels <= 2
          ) {
            ffmpegCommandInsert += `-c:a:${audioIdx} aac `;
            response.infoLog += '☒Audio track is mono/stereo but is not AAC. Converting. \n';
            convert = true;
          }
        }
      } catch (err) {
        // Error
      }

      // Catch error here incase user left inputs.downmix empty.
      try {
        // Check if inputs.ac3_surround is set to true.
        if (inputs.aac_stereo === true) {
          // Check if codec_name for stream is NOT ac3 AND check if channel ammount is >2.
          if (
            file.ffProbeData.streams[i].codec_name !== 'ac3'
            && file.ffProbeData.streams[i].channels > 2
          ) {
            ffmpegCommandInsert += `-c:a:${audioIdx} ac3 `;
            response.infoLog += '☒Audio track is >=2 channels but is not AC3. Converting. \n';
            convert = true;
          }
        }
      } catch (err) {
        // Error
      }
      audioIdx += 1;
    }
  }

  // Convert file if convert variable is set to true.
  if (convert === true) {
    response.processFile = true;
    response.preset = `, -map 0 -c:v copy -c:a copy ${ffmpegCommandInsert} `
    + '-strict -2 -c:s copy -max_muxing_queue_size 9999 ';
  } else {
    response.infoLog += '☑File contains all required audio formats. \n';
    response.processFile = false;
  }
  return response;
};
module.exports.details = details;
module.exports.plugin = plugin;
