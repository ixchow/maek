#include "Player.hpp"
#include "Level.hpp"

#include <cassert>

int main(int argc, char **argv) {
	{ //test player starting health:
		Player player;
		assert(player.health == 100);
	}

	{ //test level size:
		Level level;
		assert(level.tiles.size() == 10);
	}

	return 0;
}
