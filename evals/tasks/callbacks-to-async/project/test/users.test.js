const assert = require("node:assert/strict");
const db = require("../lib/db");
const { createUser, renameUser } = require("../lib/users");
const { userCount } = require("../lib/report");

db.reset(() => {
  createUser("  Ada ", (error, ada) => {
    assert.equal(error, null);
    assert.equal(ada.name, "Ada");
    renameUser(ada.id, "Ada L.", (error2, renamed) => {
      assert.equal(error2, null);
      assert.equal(renamed.name, "Ada L.");
      renameUser(99, "x", error3 => {
        assert.match(error3.message, /no user 99/);
        userCount((error4, count) => {
          assert.equal(count, 1);
          console.log("users tests passed");
        });
      });
    });
  });
});
