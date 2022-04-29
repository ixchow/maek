#pragma once

#include "Player.hpp"

#include <array>
#include <cstdint>

struct Level {
	Level();
	std::array< Player, 2 > players;
	std::array< uint8_t, 10 > tiles;
};
