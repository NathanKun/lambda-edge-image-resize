'use strict';

exports.handler = async (event, context, callback) => {
  // config
  const BUCKET = 'viecasa-wordpress-images';
  const DEFAULT_MAX_WIDTH = 3840;
  const DEFAULT_MAX_HEIGHT = 2160;
  const MAX_AGE = "max-age=15552000";

  const response = event.Records[0].cf.response;

  console.log("Response status code :%s", response.status);

  // pass through other responses except 403 and 404
  if (response.status != 403 && response.status != 404) {
    callback(null, response);
    return;
  }


  // image is not present, do resize and save to S3
  // Image types that can be handled by Sharp
  const supportImageTypes = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'tiff'];

  // read the S3 key from the path variable.
  // assets/images/sample.jpeg
  const request = event.Records[0].cf.request;
  const path = request.uri.substring(1);

  // parse the width, height, crop, image name
  const keyMatch = path.match(/-(\d+)x(\d+)(c?)/);

  // skip unsupported URI type
  if (keyMatch == null) {
    responseUpdate(403, "Forbidden", "Unsupported URI", [
      { key: "Content-Type", value: "text/plain" }
    ]);
    callback(null, response);
    return;
  }

  // retrieve width, height, crop from URI
  let width = parseInt(keyMatch[1]);
  if (width <= 0) {
    width = DEFAULT_MAX_WIDTH;
  }

  let height = parseInt(keyMatch[2]);
  if (height <= 0) {
    DEFAULT_MAX_HEIGHT;
  }

  const crop = keyMatch[3] === "c";

  const pathNoExt = path.substring(0, path.lastIndexOf("-"));
  const ext = path.substring(path.lastIndexOf("."));
  const key = pathNoExt + ext;

  let imageFormat = ext.substring(1);
  if (imageFormat == "jpg") {
    imageFormat = "jpeg";
  }

  // skip unsupported image type
  if (
    !supportImageTypes.some(type => {
      return type == imageFormat;
    })
  ) {
    responseUpdate(403, "Forbidden", "Unsupported image type", [
      { key: "Content-Type", value: "text/plain" }
    ]);
    callback(null, response);
    return;
  }


  // import deps
  const AWS = require('aws-sdk');
  const S3 = new AWS.S3({
    signatureVersion: 'v4',
  });
  const Sharp = require('sharp');

  try {
    // get the source image file
    const s3Object = await S3.getObject({ Bucket: BUCKET, Key: key }).promise();

    if (s3Object.ContentLength == 0) {
      responseUpdate(404, "Not Found", "The image does not exist.", [
        { key: "Content-Type", value: "text/plain" }
      ]);
      callback(null, response);
      return;
    }

    // resize
    let metaData,
      resizedImage,
      byteLength = 0;

    resizedImage = await Sharp(s3Object.Body).rotate();
    metaData = await resizedImage.metadata();

    if (metaData.width > width || metaData.height > height) {
      if (crop) {
        resizedImage.resize(width, height, { fit: "outside" });
        resizedImage.resize(width, height, { fit: "cover" });
      } else {
        resizedImage.resize(width, height, { fit: "inside" });
      }
    }

    let resizedImageBuffer = await resizedImage.toBuffer();

    byteLength = Buffer.byteLength(resizedImageBuffer, "base64");
    if (byteLength == metaData.size) {
      callback(null, response);
      return;
    }

    // save the resized object to S3 bucket with appropriate object key.
    await S3.putObject({
      Body: resizedImageBuffer,
      Bucket: BUCKET,
      ContentType: 'image/' + imageFormat,
      CacheControl: MAX_AGE,
      Key: path,
      StorageClass: 'STANDARD'
    }).promise();
    console.log("Saved resized image: ", path);

    // return image
    let body = resizedImageBuffer.toString("base64");

    // lambda@edge response json 1MB limit
    while (body.length >= 1000 * 1000) {
      const ratio = Math.sqrt(body.length / 1000 / 1000) * 1.2;
      width = Math.floor(width / ratio);
      height = Math.floor(height / ratio);
      console.log("Response bigger than 1MB, resize with lower resolution " + width + "x" + height);
      resizedImage.resize(width, height, { fit: crop ? "cover" : "inside" });
      resizedImageBuffer = await resizedImage.toBuffer();
      body = resizedImageBuffer.toString("base64");
    }

    responseUpdate(
      200,
      "OK",
      body,
      [{ key: "Content-Type", value: "image/" + imageFormat }],
      "base64"
    );

    return callback(null, response);
  } catch (err) {
    console.log("Exception!");
    console.log(err);
    console.log("path = ", path);
    console.log("key = ", key);
    callback(null, response);
  };

  function responseUpdate(
    status,
    statusDescription,
    body,
    contentHeader,
    bodyEncoding = undefined
  ) {
    response.status = status;
    response.statusDescription = statusDescription;
    response.body = body;
    response.headers["content-type"] = contentHeader;
    if (bodyEncoding) {
      response.bodyEncoding = bodyEncoding;
    }
  }
};
