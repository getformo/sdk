import { describe, it, beforeEach, afterEach } from "mocha";
import { expect } from "chai";
import * as sinon from "sinon";
import { Logger } from "../../../src/lib/logger/Logger";

describe("Logger", () => {
  let consoleDebugStub: sinon.SinonStub;
  let consoleInfoStub: sinon.SinonStub;
  let consoleWarnStub: sinon.SinonStub;
  let consoleErrorStub: sinon.SinonStub;
  let consoleTraceStub: sinon.SinonStub;

  beforeEach(() => {
    consoleDebugStub = sinon.stub(console, "debug");
    consoleInfoStub = sinon.stub(console, "info");
    consoleWarnStub = sinon.stub(console, "warn");
    consoleErrorStub = sinon.stub(console, "error");
    consoleTraceStub = sinon.stub(console, "trace");
  });

  afterEach(() => {
    sinon.restore();
  });

  describe("getInstance", () => {
    it("should return a singleton instance", () => {
      const instance1 = Logger.getInstance();
      const instance2 = Logger.getInstance();
      expect(instance1).to.equal(instance2);
    });

    it("should accept initial config", () => {
      const instance = Logger.getInstance({
        enabled: true,
        enabledLevels: ["info"],
      });
      expect(instance).to.not.be.null;
    });
  });

  describe("init", () => {
    it("should configure the logger", () => {
      Logger.init({
        enabled: true,
        enabledLevels: ["info", "warn", "error"],
      });

      const logger = Logger.getInstance();
      expect(logger.isLoggingEnabled()).to.be.true;
      expect(logger.getEnabledLevels()).to.include("info");
      expect(logger.getEnabledLevels()).to.include("warn");
      expect(logger.getEnabledLevels()).to.include("error");
    });

    it("should update enabled state", () => {
      Logger.init({ enabled: false });
      expect(Logger.getInstance().isLoggingEnabled()).to.be.false;

      Logger.init({ enabled: true });
      expect(Logger.getInstance().isLoggingEnabled()).to.be.true;
    });
  });

  describe("setEnabled / isLoggingEnabled", () => {
    it("should enable logging", () => {
      const logger = Logger.getInstance();
      logger.setEnabled(true);
      expect(logger.isLoggingEnabled()).to.be.true;
    });

    it("should disable logging", () => {
      const logger = Logger.getInstance();
      logger.setEnabled(false);
      expect(logger.isLoggingEnabled()).to.be.false;
    });
  });

  describe("setEnabledLevels / getEnabledLevels", () => {
    it("should set enabled levels", () => {
      const logger = Logger.getInstance();
      logger.setEnabledLevels(["debug", "info"]);
      expect(logger.getEnabledLevels()).to.deep.equal(["debug", "info"]);
    });

    it("should replace previous levels", () => {
      const logger = Logger.getInstance();
      logger.setEnabledLevels(["debug", "info"]);
      logger.setEnabledLevels(["warn", "error"]);
      expect(logger.getEnabledLevels()).to.deep.equal(["warn", "error"]);
    });

    it("should handle empty array", () => {
      const logger = Logger.getInstance();
      logger.setEnabledLevels([]);
      expect(logger.getEnabledLevels()).to.deep.equal([]);
    });
  });

  describe("logging methods", () => {
    beforeEach(() => {
      Logger.init({
        enabled: true,
        enabledLevels: ["debug", "info", "warn", "error", "trace"],
      });
    });

    describe("debug", () => {
      it("should log debug message when enabled", () => {
        const logger = Logger.getInstance();
        logger.debug("Debug message");
        expect(consoleDebugStub.calledOnce).to.be.true;
        expect(consoleDebugStub.firstCall.args[0]).to.include("Debug message");
      });

      it("should not log debug when disabled", () => {
        Logger.init({ enabled: false });
        const logger = Logger.getInstance();
        logger.debug("Debug message");
        expect(consoleDebugStub.called).to.be.false;
      });

      it("should not log debug when level not enabled", () => {
        Logger.init({ enabled: true, enabledLevels: ["info"] });
        const logger = Logger.getInstance();
        logger.debug("Debug message");
        expect(consoleDebugStub.called).to.be.false;
      });
    });

    describe("info", () => {
      it("should log info message when enabled", () => {
        const logger = Logger.getInstance();
        logger.info("Info message");
        expect(consoleInfoStub.calledOnce).to.be.true;
        expect(consoleInfoStub.firstCall.args[0]).to.include("Info message");
      });

      it("should not log info when disabled", () => {
        Logger.init({ enabled: false });
        const logger = Logger.getInstance();
        logger.info("Info message");
        expect(consoleInfoStub.called).to.be.false;
      });
    });

    describe("warn", () => {
      it("should log warn message when enabled", () => {
        const logger = Logger.getInstance();
        logger.warn("Warning message");
        expect(consoleWarnStub.calledOnce).to.be.true;
        expect(consoleWarnStub.firstCall.args[0]).to.include("Warning message");
      });

      it("should not log warn when disabled", () => {
        Logger.init({ enabled: false });
        const logger = Logger.getInstance();
        logger.warn("Warning message");
        expect(consoleWarnStub.called).to.be.false;
      });
    });

    describe("error", () => {
      it("should log error message when enabled", () => {
        const logger = Logger.getInstance();
        logger.error("Error message");
        expect(consoleErrorStub.calledOnce).to.be.true;
        expect(consoleErrorStub.firstCall.args[0]).to.include("Error message");
      });

      it("should not log error when disabled", () => {
        Logger.init({ enabled: false });
        const logger = Logger.getInstance();
        logger.error("Error message");
        expect(consoleErrorStub.called).to.be.false;
      });
    });

    describe("trace", () => {
      it("should log trace message when enabled", () => {
        const logger = Logger.getInstance();
        logger.trace("Trace message");
        expect(consoleTraceStub.calledOnce).to.be.true;
        expect(consoleTraceStub.firstCall.args[0]).to.include("Trace message");
      });

      it("should not log trace when disabled", () => {
        Logger.init({ enabled: false });
        const logger = Logger.getInstance();
        logger.trace("Trace message");
        expect(consoleTraceStub.called).to.be.false;
      });
    });

    describe("log", () => {
      it("should call info method", () => {
        const logger = Logger.getInstance();
        logger.log("Log message");
        expect(consoleInfoStub.calledOnce).to.be.true;
        expect(consoleInfoStub.firstCall.args[0]).to.include("Log message");
      });
    });
  });

  describe("message formatting", () => {
    beforeEach(() => {
      Logger.init({
        enabled: true,
        enabledLevels: ["info"],
      });
    });

    it("should include Formo SDK prefix", () => {
      const logger = Logger.getInstance();
      logger.info("Test message");
      expect(consoleInfoStub.firstCall.args[0]).to.include("[Formo SDK]");
    });

    it("should include timestamp", () => {
      const logger = Logger.getInstance();
      logger.info("Test message");
      // Check that the message contains date-like format
      const message = consoleInfoStub.firstCall.args[0];
      expect(message).to.match(/\[\d{2}\/\d{2}\/\d{4}/);
    });

    it("should include the actual message", () => {
      const logger = Logger.getInstance();
      logger.info("Custom log message here");
      expect(consoleInfoStub.firstCall.args[0]).to.include("Custom log message here");
    });
  });

  describe("additional arguments", () => {
    beforeEach(() => {
      Logger.init({
        enabled: true,
        enabledLevels: ["info", "error"],
      });
    });

    it("should pass additional arguments to console", () => {
      const logger = Logger.getInstance();
      const extraData = { key: "value" };
      logger.info("Message with data", extraData);
      expect(consoleInfoStub.calledOnce).to.be.true;
      expect(consoleInfoStub.firstCall.args[1]).to.deep.equal(extraData);
    });

    it("should pass multiple additional arguments", () => {
      const logger = Logger.getInstance();
      logger.error("Error occurred", "arg1", "arg2", { data: "test" });
      expect(consoleErrorStub.calledOnce).to.be.true;
      expect(consoleErrorStub.firstCall.args).to.have.lengthOf(4);
    });
  });
});
