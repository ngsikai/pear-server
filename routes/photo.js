var express = require('express')
var router = express.Router()
var passport = require('passport')
var models = require('../models')
var fetch = require('node-fetch')
var request = require('request')
var helper = require('./helper')
var CustomError = helper.CustomError
var SERVER_ERROR_MSG = helper.SERVER_ERROR_MSG

router.use('*', passport.authenticate(['jwt'], { session: false }), function (req, res, next) {
  next()
})

function store (s3, photoId, facebookToken) {
  return new Promise(function (resolve, reject) {
    var url = `https://graph.facebook.com/${photoId}/picture?access_token=${facebookToken}`
    request({
      url: url,
      encoding: null
    }, function (err, res, body) {
      if (err) { reject(err) }
      s3.putObject({
        Bucket: 'pear-server',
        Key: photoId,
        ContentType: res.headers['content-type'],
        ContentLength: res.headers['content-length'],
        Body: body // buffer
      }, function (err, res) {
        if (err) { reject(err) }
        resolve(photoId)
      })
    })
  })
}

router.get('/', function (req, res) {
  var userId = req.user.userId
  var facebookToken = null
  var s3 = req.app.get('s3')

  models.Users.findById(userId).then(user => {
    if (user) {
      facebookToken = user.facebookToken
      var albumUrl = `https://graph.facebook.com/${user.facebookId}/albums?access_token=${user.facebookToken}`
      return fetch(albumUrl)
    } else {
      return new Promise(function (resolve, reject) {
        reject(new CustomError('InvalidUserIdError', `Invalid User id ${userId}`, 'Invalid User id'))
      })
    }
  }).then(response => {
    return response.json()
  }).then(albums => {
    return new Promise(function (resolve, reject) {
      albums.data.forEach(function (value) {
        if (value.name === 'Profile Pictures') {
          resolve(value.id)
        }
      })
      reject(new CustomError('NoProfilePicturesAlbum', `No Profile Pictures album for User ${userId}`, 'No Profile Pictures album'))
    })
  }).then(albumId => {
    var photoUrl = `https://graph.facebook.com/${albumId}/photos?access_token=${facebookToken}`
    return fetch(photoUrl)
  }).then(response => {
    return response.json()
  }).then(photos => {
    var promises = []
    photos.data.map(function (value) {
      var promise = store(s3, value.id, facebookToken)
      promises.push(promise)
    })
    return Promise.all(promises)
  }).then(photoIds => {
    helper.successLog(req.originalUrl, `GET profile pictures of User ${userId} from Facebook`)
    return res.send(photoIds)
  }).catch(e => {
    if (e.name === 'InvalidUserIdError' || e.name === 'NoProfilePicturesAlbum') {
      helper.errorLog(req.originalUrl, e)
      return res.status(400).send({ message: e.clientMsg })
    } else {
      helper.errorLog(req.originalUrl, e)
      return res.status(500).send({ message: SERVER_ERROR_MSG })
    }
  })
})

function addPhoto (userId, photoId, order) {
  return new Promise(function (resolve, reject) {
    models.Photos.findOrCreate({
      where: {
        ownerId: userId,
        order: order
      },
      defaults: {
        photoId: photoId
      }
    }).then(photo => {
      if (!photo[1]) { // is found
        return photo[0].updateAttributes({
          photoId: photoId
        })
      } else { // is created
        resolve()
      }
    }).then(_ => {
      resolve()
    }).catch(e => {
      reject(e)
    })
  })
}

router.post('/', function (req, res) {
  var userId = req.user.userId
  var photoIds = req.body.photoIds.slice(0, 6)

  models.sequelize.transaction(function (t) {
    var promises = []
    photoIds.forEach(function (photoId, order) {
      var promise = addPhoto(userId, photoId, order)
      promises.push(promise)
    })
    return Promise.all(promises)
  }).then(_ => {
    helper.successLog(req.originalUrl, `Updated photos of User ${userId}`)
    return res.send({})
  }).catch(e => {
    helper.errorLog(req.originalUrl, e)
    return res.status(500).send({ message: SERVER_ERROR_MSG })
  })
})

module.exports = router
