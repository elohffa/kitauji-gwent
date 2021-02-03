var Cache = require("./dao/cache");
var Const = require("./Const");
var LuckyDraw = require("./LuckyDraw");
var Quest = require("./Quest");
const CompetitionService = require("./service/competitionService");
const Auth = require("./service/auth");

var User = (function(){
  var User = function(socket, token){
    if(!(this instanceof User)){
      return (new User(socket, token));
    }
    /**
     * constructor here
     */


    this.socket = socket;
    this.token = token;
    this.userModel = null;
    this._deck = null;
    this._rooms = [];
    this._id = socket.id;
    this.init();

    this._events();
  };
  var r = User.prototype;
  /**
   * methods && properties here
   * r.property = null;
   * r.getProperty = function() {...}
   */

  r._id = null;
  r._name = null;
  r._rooms = null;
  r._roomKey = null;
  r._scenario = null;
  r._inQueue = false;
  r.socket = null;
  r.disconnected = false;
  r._battleSide = null;
  r._waitingSeq = 0;

  r.isBot = function() {
    return false;
  }

  r.getID = function(){
    return this._id;
  }

  r.init = async function() {
    let valid = await this.validateToken();
    this.send("user:init", {
      connId: this._id,
      needLogin: !valid,
      model: this.userModel,
    });
    this.socket.emit("update:playerOnline", {
      online: connections.length(),
      idle: connections.getIdleUserCount(),
    });
  }

  r.loadUserModel = async function(username) {
    try {
      this.userModel = await db.findUserByName(username);
    } catch (e) {
      console.warn(e);
    }
    if (!this.userModel) return;
    this.userModel.wallet = this.userModel.wallet || 0;
    this.userModel.isAdmin = Auth.isAdmin(username);
    this._deck = await db.loadCustomDeck(username, this.userModel.currentDeck);
  }

  /**
   * {
   *  username: username,
   *  expireTime: timestamp,
   * }
   */
  r.validateToken = async function() {
    if (!this.token) return false;
    try {
      let data = JSON.parse(new Buffer(this.token, "base64").toString());
      if (data.expireTime < new Date().getTime()) {
        return false;
      }
      await this.loadUserModel(data.username);
      if (!this.userModel) {
        this.disconnect();
        return false;
      }
      return true;
    } catch (e) {
      console.warn(e);
      return false;
    }
  }

  r.generateToken = function() {
    let data = {
      username: this.userModel.username,
      expireTime: new Date().getTime() + 864000 * 1000, // 10 days
    }
    return new Buffer(JSON.stringify(data)).toString("base64");
  }

  r.send = function(event, data, room){
    room = room || null;
    data = data || null;
    if(!room){
      this.socket.emit(event, data);
    }
    else {
      this.socket.to(room).emit(event, data);
    }
  }

  r.setName = function(name) {
    name = name.slice(0, 20);
    console.log("user name changed from %s to %s", this._name, name);
    this._name = name;
  }

  r.getName = function() {
    return this.userModel ? this.getDisplayName() : "anonymous";
  }

  r.getRoom = function() {
    return this._rooms[0];
  }

  r.setDeck = function(deck) {
    this._deck = deck;
  }

  r.getDeck = function() {
    if (this._roomKey) {
      let room = matchmaking.getRoomById(this._roomKey);
      if (room && room.mode === Const.FUN_MODE) {
        // user may not have same deck in fun mode
        if (room.players && room.decks) {
          return room.decks[room.players.indexOf(this.getUserModel().username)];
        }
        if (room.deck) {
          return room.deck;
        }
      }
    }
    return this._deck;
  }

  r.getScenario = function() {
    return this._scenario;
  }

  r.getUserModel = function() {
    return this.userModel;
  }

  r.getDisplayName = function() {
    return `${this.userModel.bandName}(${this.userModel.username})`;
  }

  r.addRoom = function(room) {
    this._rooms.push(room);
  }

  r.isIdle = function() {
    return this._rooms.length === 0;
  }

  r.reconnect = function(socket) {
    this.disconnected = false;
    this.socket = socket;
    this._events();
    this._battleSide && this._battleSide.rejoin(socket);
    this.getRoom() && this.getRoom().rejoin(this);
  }

  r.leaveRoom = function() {
    var self = this;
    this._rooms.forEach(function(room) {
      room.leave(self);
    });
    this._rooms = [];
  }

  r.connecting = function() {
    let room = this.getRoom();
    if (room) {
      room.connecting(this);
    }
  }

  r.waitForReconnect = function() {
    this.disconnected = true;
    this.connecting();
    if (this._rooms.length === 0 || this.getRoom().hasUser() === 1) {
      // not in game, or foe has left, disconnect immediately
      this.disconnect();
      return;
    }
    this._waitingSeq++;
    let waitingSeq = this._waitingSeq;
    // wait for 30s
    setTimeout(() => {
      if (waitingSeq !== this._waitingSeq) return;
      if (this.disconnected) {
        this.disconnect();
      }
    }, 30000);
  }

  r.disconnect = function() {
    connections.remove(this);
    matchmaking.removeFromQueue(this, this._roomKey);

    this.leaveRoom();
    // console.log("user ", this.getName(), " disconnected");
  }

  r.setBattleSide = function(battleSide) {
    this._battleSide = battleSide;
  }

  /**
   * Record game state, etc.
   */
  r.endGame = async function(gameState, faction, foe) {
    let result = {};
    if (!foe.isBot()) {
      await Cache.getInstance().recordUserWin(this.userModel.username, gameState.isWin);
    }

    await matchmaking.endGame(this._roomKey, this.userModel, gameState, result);
    if (result.coins) {
      await db.updateWallet(this.userModel.username, result.coins);
    }

    if (!this._scenario) return result;
    // update quest progress
    let questState = await Quest.updateQuestProgress(this.userModel, this._scenario, {
      foeName: foe.getName(),
      isWin: gameState.isWin,
    });
    result["questState"] = questState;

    // both side won't get reward if someone quit.
    if (gameState.isQuit) return;

    // do lucky draw based on result
    try {
      let newLeader = await this.luckyDrawLeaderAfterGame_(faction, questState);
      if (newLeader) {
        result["newCard"] = newLeader;
        // console.info("user get new leader: ", newLeader);
        return result;
      }
      let newCard = await this.luckyDrawAfterGame_(gameState.isWin, faction, foe, questState);
      if (newCard && newCard.length) {
        result["newCard"] = newCard;
        // console.info("user get new card: ", result["newCard"]);
        return result;
      }
      let coins = await this.getCoinAfterGame_(gameState);
      if (coins) {
        result["coins"] = coins;
        // console.info("user get coins: ", coins);
        return result;
      }
    } catch (e) {
      console.warn(e);
    }
    return result;
  }

  r.luckyDrawLeaderAfterGame_ = async function(faction, questState) {
    // must complete kansai or zenkoku
    if (!questState.completed) return null;
    if (this._scenario !== Const.SCENARIO_KANSAI && this._scenario !== Const.SCENARIO_ZENKOKU) return null;
    if (Math.random() > 0.2) return null;
    let userLeaders = await db.findLeaderCardsByUser(this.userModel.username);
    let newLeader = LuckyDraw.getInstance().drawLeader(faction, userLeaders);
    if (newLeader) {
      await db.addLeaderCards(this.userModel.username, [newLeader]);
    }
    return newLeader;
  }

  r.luckyDrawAfterGame_ = async function(isWin, deck, foe, questState) {
    if (!isWin && !questState.completed) return [];
    let scenario = this._scenario;
    let possibility = 0;
    if (foe.isBot()) possibility = 1;
    else possibility = 0.7;
    if (questState.success) {
      possibility = 1;
      scenario = Quest.getNextScenario(scenario);
    }
    if (Math.random() > possibility) return [];
    if (await Cache.getInstance().getCondition(this.userModel.username, Const.COND_UNLOCK_ALL_DECK)) {
      let {faction, cards} = await LuckyDraw.getInstance().drawPreferOtherDeck(scenario, this.userModel.username, this.userModel.initialDeck);
      await db.addCards(this.userModel.username, faction, cards);
      return cards;
    }
    let {faction, cards} = await LuckyDraw.getInstance().drawSingleAvoidDuplicate(scenario, this.userModel.username, deck);
    await db.addCards(this.userModel.username, faction, cards);
    return cards;
  }

  r.getCoinAfterGame_ = async function(gameState) {
    let coins = LuckyDraw.getInstance().calculateCoin(gameState, this._scenario);
    if (coins) {
      await db.updateWallet(this.userModel.username, coins);
    }
    return coins;
  }

  r.getQuestProgress_ = async function() {
    let progress = {};
    if (!this.userModel) return progress;
    let tasks = await db.findProgressByUser(this.userModel.username);
    for (let task of tasks) {
      progress[task.questName] = task.progress.length;
    }
    return progress;
  }

  r.getUserCollections_ = async function() {
    let response = {
      currentDeck: this.userModel.currentDeck,
      collections: {},
      leaderCollection: {},
      customDecks: {},
    };
    let allDecks = await db.findAllCardsByUser(this.userModel.username);
    for (let deck of allDecks) {
      if (deck.isCustomDeck || deck.isLeaderCard) continue;
      response.collections[deck.deck] = deck.cards;
    }
    response.leaderCollection = await db.findLeaderCardsByUser(this.userModel.username);
    let customDecks = await db.loadAllCustomDeck(this.userModel.username);
    for (let deck of customDecks) {
      response.customDecks[deck.deck] = deck.customDeck;
    }
    return response;
  }

  r.getCompetitionInfo_ = async function(compId, includeTree) {
    if (!this.userModel) return null;
    let info = await CompetitionService.getInstance().getCompetitionInfo(compId) || {};
    if (!info) return null;
    let candidates = Object.values(info.candidateMap || {}).reverse();
    let result = info.comp || {};
    if (candidates.length > 10) {
      result.playerStr = candidates.slice(0, 10)
        .map(c=>`${c.bandName}(${c.username})`)
        .join(", ") + ` 等 ${candidates.length} 人`;
    } else {
      result.playerStr = candidates
        .map(c=>`${c.bandName}(${c.username})`)
        .join(", ");
    }
    result.playerNum = candidates.length;
    result.hasMe = candidates.some(c=>c.username === this.userModel.username);
    if (includeTree) {
      result.tree = info.tree;
      matchmaking.getRoomsForCompetition(compId, result.tree);
    }
    result.result = info.result;
    return result;
  }

  r.testData_ = async function(data) {
      // give initial 12 cards
      let cards = await LuckyDraw.getInstance().draw(80, Const.SCENARIO_ZENKOKU, data.username, "kitauji", true);
      await db.addCards(data.username, "kitauji", cards);
      cards = await LuckyDraw.getInstance().draw(80, Const.SCENARIO_ZENKOKU, data.username, "kumiko1", true);
      await db.addCards(data.username, "kumiko1", cards);
      cards = await LuckyDraw.getInstance().draw(80, Const.SCENARIO_ZENKOKU, data.username, "kumiko1S2", true);
      await db.addCards(data.username, "kumiko1S2", cards);
      // give initial leader card
      await db.addLeaderCards(data.username, [Const.DEFAULT_LEADER]);
      cards.push(Const.DEFAULT_LEADER);
      await db.addLeaderCards(data.username, ["tanaka_asuka_shiki", "oumae_kumiko_shiki"]);
      // give initial coins
      await db.updateWallet(data.username, 10000);
      // start first quest
      await db.updateProgress(data.username, Const.SCENARIO_ZENKOKU, []);

  }

  r._events = function() {
    var socket = this.socket;
    var self = this;

    socket.on("request:login", async function(data) {
      let userModel = await db.findUserByName(data.username);
      let msg, success = false, token;
      if (!userModel) {
        msg = "msg_no_user";
      } else if (data.password !== userModel.password) {
        // dangerous
        msg = "msg_wrong_password";
      } else {
        msg = "msg_login_success";
        success = true;
        await self.loadUserModel(data.username);
        token = self.generateToken();
      }
      socket.emit("response:login", {
        success: success,
        token: token,
        model: self.userModel,
      });
      socket.emit("notification", {msgKey: msg});
    });

    socket.on("request:signin", async function(data) {
      let exist = await db.findUserByName(data.username);
      if (exist) {
        socket.emit("response:signin", {success: false});
        socket.emit("notification", {msgKey: "msg_user_exist", values: [data.username]});
        return;
      }
      data.bandName = data.bandName || "北宇治高等学校";
      data.initialDeck = data.initialDeck || "kitauji";
      if (data.initialDeck === "random") {
        data.initialDeck = LuckyDraw.getRandomDeck();
      }
      await db.addUser(data);

      // give initial 12 cards
      let cards = await LuckyDraw.getInstance().draw(12, Const.SCENARIO_KYOTO, data.username, data.initialDeck, true);
      await db.addCards(data.username, data.initialDeck, cards);
      // give initial leader card
      await db.addLeaderCards(data.username, [Const.DEFAULT_LEADER]);
      cards.push(Const.DEFAULT_LEADER);
      // give initial coins
      await db.updateWallet(data.username, 50);
      // set default deck
      await db.storeCustomDeckByList(data.username, data.initialDeck, cards);
      // start first quest
      await db.updateProgress(data.username, Const.SCENARIO_KYOTO, []);
      // await self.testData_(data);

      await self.loadUserModel(data.username);

      socket.emit("response:signin", {
        success: true,
        token: self.generateToken(),
        model: self.userModel,
        initialCards: cards,
      });
    });

    socket.on("request:questProgress", async function() {
      let progress = await self.getQuestProgress_();
      socket.emit("response:questProgress", progress);
    });

    socket.on("request:userCollections", async function() {
      let response = await self.getUserCollections_();
      socket.emit("response:userCollections", response);
    });

    socket.on("request:ranking", async function() {
      let result = {
        myRank: null,
        ranking: [],
      }
      let users = await Cache.getInstance().getTopK(10);
      let i = 1;
      for (let user of users) {
        result.ranking.push({
          rank: i++,
          username: user.username,
          bandName: user.bandName,
          winCount: user.winCount,
          loseCount: user.loseCount,
        });
      }
      result.myRank = await Cache.getInstance().getUserRank(self.userModel.username);
      socket.emit("response:ranking", result);
    });

    socket.on("request:updateUserInfo", async function(data){
      if(!data){
        return;
      }
      if (data.bandName) {
        self.userModel.bandName = data.bandName;
      }
      if (data.password) {
        if (data.oldPassword !== self.userModel.password) {
          socket.emit("notification", {msgKey: "msg_wrong_password"});
          return;
        }
        self.userModel.password = data.password;
      }
      await db.updateUser(self.userModel);
      socket.emit("response:updateUserInfo", {user: self.userModel});
    })

    socket.on("request:matchmaking", function(data) {
      if (self.getRoom()) return;
      if(self._inQueue) {
        matchmaking.removeFromQueue(self, self._roomKey);
      }
      if (data.cancel) {
        // just cancel previous match request
        return;
      }
      self._roomKey = data.roomName;
      self._scenario = data.scenario;
      if (self._scenario) {
        switch (self._scenario) {
          case Const.ROOM_KANSAI:
            self._roomKey = Const.ROOM_KANSAI;
            break;
          case Const.ROOM_ZENKOKU:
            self._roomKey = Const.ROOM_ZENKOKU;
            break;
          case Const.SCENARIO_KYOTO:
          default:
            self._roomKey = Const.ROOM_KYOTO;
            break;
        }
      }
      if (data.bot) {
        matchmaking.findBotOpponent(self);
        return;
      }
      matchmaking.findOpponent(self, self._roomKey);
    });

    socket.on("request:joinRoom", function(data) {
      //TODO: join room, set deck if needed
    });

    socket.on("request:makeRoom", function(data) {
      if (self.getRoom()) return;
      if(self._inQueue) {
        matchmaking.removeFromQueue(self, self._roomKey);
      }
      let roomKey = matchmaking.makeRoom(self, data);
      self._roomKey = roomKey;
      socket.emit("response:rooms", matchmaking.getRooms());
    });

    socket.on("request:rooms", function() {
      socket.emit("response:rooms", matchmaking.getRooms());
    });

    socket.on("request:makeCompetition", async function(data) {
      if (!Auth.canCreateComp(self.userModel.username)) {
        socket.emit("notification", {msgKey: "msg_no_authority"});
        return;
      }
      data.organizer = self.userModel.username;
      let inst = CompetitionService.getInstance();
      await inst.addCompetition(data);
      socket.emit("response:competitions", await inst.getCompetitions());
    });

    socket.on("request:competitions", async function() {
      socket.emit("response:competitions", await CompetitionService.getInstance().getCompetitions());
    });

    socket.on("request:competition", async function(data) {
      let result = await self.getCompetitionInfo_(data.compId, data.includeTree);
      if (!result) return;
      socket.emit("response:competition", result);
    });

    socket.on("request:compEnroll", async function(data) {
      let {compId, quit} = data;
      if (quit) {
        await CompetitionService.getInstance().quit(self.userModel, compId);
      } else {
        let ok = await CompetitionService.getInstance().enroll(self.userModel, compId);
        if (!ok) {
          socket.emit("notification", {msgKey: "msg_enroll_failed"});
          return;
        }
      }
      let result = await self.getCompetitionInfo_(compId);
      if (!result) return;
      socket.emit("response:competition", result);
    });

    socket.on("request:compDelete", async function(data) {
      if (!Auth.isAdmin(self.userModel.username)) {
        socket.emit("notification", {msgKey: "msg_no_authority"});
        return;
      }
      let {compId} = data;
      await CompetitionService.getInstance().deleteCompetition(compId);
      socket.emit("response:competitions", await CompetitionService.getInstance().getCompetitions());
    });

    socket.on("request:compReady", async (data) => {
      let {compId, nodeIndex, cancel} = data;
      if (self.getRoom()) return;
      if(self._inQueue) {
        matchmaking.removeFromQueue(self, self._roomKey);
      }
      if (cancel) return;
      self._roomKey = await CompetitionService.getInstance().compReady(self, compId, nodeIndex);
    });

    socket.on("request:compForceWin", async function(data) {
      if (!Auth.isAdmin(self.userModel.username)) {
        console.warn("force win failed: no authority", self.userModel.username);
        return;
      }
      let {compId, nodeIndex, username} = data;
      await CompetitionService.getInstance().winGame(username, compId, nodeIndex);
    });

    socket.on("request:compWatch", function(data) {
      let {compId, nodeIndex} = data;
      if (self.getRoom()) return;
      if(self._inQueue) {
        matchmaking.removeFromQueue(self, self._roomKey);
      }
      matchmaking.watchGame(self, `${compId}#${nodeIndex}`);
    });

    socket.on("request:gameLoaded", function(data){
      //console.log(data);
      if (!connections.roomCollection[data._roomID]) {
        console.warn("user left before game loaded: ", data);
        return;
      }
      connections.roomCollection[data._roomID].setReady(self);
    })

    socket.on("set:customDeck", async function(data) {
      if (!data || !self.userModel) {
        return;
      }
      self.userModel.currentDeck = data.deck;
      self.setDeck(data);
      await db.storeCustomDeck(self.userModel.username, data.deck, data);
      await db.updateUser(self.userModel);
    })

    socket.on("request:quitGame", function() {
      self.disconnect();
    })

    socket.on("request:sell", async function(data) {
      let {faction, card, amount} = data;
      let ok = await db.removeCard(self.userModel.username, faction, card, amount);
      if (ok) {
        let coins = LuckyDraw.getInstance().calculatePrice(card, amount);
        await db.updateWallet(self.userModel.username, coins);
        self.userModel.wallet += coins;
        let response = await self.getUserCollections_();
        socket.emit("response:userCollections", response);
      }
    })

    socket.on("request:luckyDraw", async function(data) {
      let {scenario} = data;
      let price = LuckyDraw.getInstance().getPriceForLuckyDraw(scenario);
      if (price > (self.userModel.wallet || 0)) {
        socket.emit("response:luckyDraw", {});
        return;
      }
      let ok = await db.updateWallet(self.userModel.username, price, true);
      if (!ok) {
        socket.emit("response:luckyDraw", {});
        return;
      }
      let {faction, cards} = await LuckyDraw.getInstance()
        .drawSingleAvoidDuplicate(scenario, self.userModel.username, self.userModel.initialDeck);
      await db.addCards(self.userModel.username, faction, cards);
      socket.emit("response:luckyDraw", {
        newCard: cards,
      });
    });

    socket.on("request:resetQuest", async function(data) {
      let {scenario} = data;
      await db.updateProgress(self.userModel.username, scenario, []);
      let progress = await self.getQuestProgress_();
      socket.emit("response:questProgress", progress);
    })
  }

  return User;
})();

module.exports = User;